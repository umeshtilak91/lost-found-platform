const express = require("express");

function createAuthenticatedApp(app, user) {
    const testApp = express();

    testApp.use((req, res, next) => {
        req.isAuthenticated = () => true;
        req.user = user;
        next();
    });

    testApp.use(app);

    return testApp;
}

module.exports = createAuthenticatedApp;