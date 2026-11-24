"use strict";

const passport = require("passport");
const { resolveIdentity, loadUser } = require("./accounts");

function configurePassport({ pool, config, logger }) {
  const instance = new passport.Passport();

  if (config.google) {
    const { Strategy: GoogleStrategy } = require("passport-google-oauth20");
    instance.use(
      new GoogleStrategy(
        { ...config.google, scope: ["profile", "email"], state: true },
        async (_accessToken, _refreshToken, profile, done) => {
          try {
            const email = profile.emails?.[0];
            const user = await resolveIdentity(pool, {
              provider: "google",
              subject: profile.id,
              email: email?.value,
              emailVerified: email?.verified === true || email?.verified === "true",
              name: profile.displayName,
              profileImage: profile.photos?.[0]?.value,
            });
            done(null, user);
          } catch (error) {
            logger.error({ err: error }, "Google sign-in failed");
            done(error);
          }
        }
      )
    );
  }

  if (config.apple) {
    const AppleStrategy = require("passport-apple");
    instance.use(
      "apple",
      new AppleStrategy(
        { ...config.apple, passReqToCallback: false, scope: ["name", "email"] },
        async (_accessToken, _refreshToken, idToken, profile, done) => {
          try {
            // passport-apple returns the verified id_token claims.
            const claims = typeof idToken === "object" ? idToken : JSON.parse(Buffer.from(idToken.split(".")[1], "base64url"));
            const user = await resolveIdentity(pool, {
              provider: "apple",
              subject: claims.sub,
              email: claims.email,
              emailVerified: claims.email_verified === true || claims.email_verified === "true",
              name: profile?.name ? `${profile.name.firstName || ""} ${profile.name.lastName || ""}`.trim() : null,
            });
            done(null, user);
          } catch (error) {
            logger.error({ err: error }, "Apple sign-in failed");
            done(error);
          }
        }
      )
    );
  }

  instance.serializeUser((user, done) => done(null, user.id));
  instance.deserializeUser(async (id, done) => {
    try {
      done(null, (await loadUser(pool, id)) || false);
    } catch (error) {
      done(error);
    }
  });

  return instance;
}

module.exports = { configurePassport };
