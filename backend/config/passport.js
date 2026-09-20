const GoogleStrategy =
  require("passport-google-oauth20").Strategy;

const pool = require("../db");

function configurePassport(passport) {
  // ======================================================
  // GOOGLE PASSPORT STRATEGY
  // ======================================================

  passport.use(
    new GoogleStrategy(
      {
        clientID: process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        callbackURL:
          "http://localhost:5000/api/auth/google/callback",
      },

      async (accessToken, refreshToken, profile, done) => {
        try {
          console.log("Google profile:", profile);

          const googleId = profile.id;
          const name = profile.displayName;
          const email = profile.emails?.[0]?.value;
          const profileImage =
            profile.photos?.[0]?.value || null;

          // Check if user already exists
          const existingUser = await pool.query(
            "SELECT * FROM users WHERE google_id = $1",
            [googleId]
          );

          if (existingUser.rows.length > 0) {
            console.log("✅ Existing user found");

            return done(null, existingUser.rows[0]);
          }

          // Create new user
          const result = await pool.query(
            `INSERT INTO users
              (google_id, name, email, profile_image)
             VALUES ($1, $2, $3, $4)
             RETURNING *`,
            [googleId, name, email, profileImage]
          );

          console.log("✅ New user created");

          return done(null, result.rows[0]);

        } catch (error) {
          console.error(
            "User authentication/database error:",
            error
          );

          return done(error, null);
        }
      }
    )
  );

  // ======================================================
  // PASSPORT SESSION
  // ======================================================

  passport.serializeUser((user, done) => {
    done(null, user.id);
  });

  passport.deserializeUser(async (id, done) => {
    try {
      const result = await pool.query(
        `SELECT
          id,
          google_id,
          name,
          email,
          profile_image,
          mobile_number,
          allow_phone_contact
         FROM users
         WHERE id = $1`,
        [id]
      );

      if (result.rows.length === 0) {
        return done(null, false);
      }

      done(null, result.rows[0]);

    } catch (error) {
      console.error(
        "Session user lookup error:",
        error
      );

      done(error, null);
    }
  });
}

module.exports = configurePassport;