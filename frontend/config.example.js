// Copy this file to `config.js` and paste your Lambda Function URL from the
// stack outputs (the `ApiUrl` value). The deploy script does this for you.
//
//   window.POSMP_CONFIG = { apiUrl: "https://xxxx.lambda-url.us-east-1.on.aws" };
//
// If config.js is absent, the app asks for the URL on first load and remembers
// it in the browser — handy for local testing.
window.POSMP_CONFIG = { apiUrl: "" };
