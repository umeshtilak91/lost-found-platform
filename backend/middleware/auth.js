function ensureAuthenticated(req, res, next) {
  if (req.isAuthenticated()) {
    return next();
  }

  return res.status(401).json({
    message: "Please login with Google first",
  });
}

module.exports = ensureAuthenticated;