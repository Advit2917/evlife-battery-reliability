EVLife — EV BATTERY RELIABILITY WORKSPACE
=========================================

RUN LOCALLY
1. Install Node.js 22.
2. Open a terminal in this folder and run: npm install
3. Start the website: npm start
4. Open http://localhost:3000 and create an account.

Locally, the server creates a SQLite database at data/evlife.sqlite. Set
DATABASE_PATH to choose another database location. On Vercel, configure
DATABASE_URL with the Neon pooled connection string; Vercel refuses to start
the API without it rather than silently saving to temporary disk. Each account
has a private battery profile and saved model/validation settings. Passwords
are stored as scrypt hashes; account sessions use random, HttpOnly, SameSite
cookies.
The application must be open at http://localhost:3000 (not opened as a
file:// URL) and the Node server must remain running for saves to reach SQLite.
The account header shows when changes are saving, saved, or if a save fails.

VERCEL + NEON DEPLOYMENT
1. Push this folder to a private GitHub repository (do not include .env,
   node_modules, or data/*.sqlite).
2. Import that repository into Vercel.
3. Create a Neon Postgres project and copy its pooled connection string.
4. In Vercel project settings, set DATABASE_URL to that connection string,
   then redeploy. The database schema is created automatically at first use.
5. Test account registration and saving at the deployed HTTPS URL.

Vercel's filesystem is not persistent, so do not configure SQLite there.
Neon stores accounts, sessions, and workspaces. To copy existing local SQLite
accounts/data to a new Neon database, set DATABASE_URL in your local shell and
run `npm run migrate:neon` once before deployment. Review the destination
database first; existing accounts with matching emails are retained and their
existing destination workspaces are not overwritten.

The app compares mutating request origins with the current request host so
Vercel preview URLs work. For a fixed public domain, set PUBLIC_ORIGIN to that
HTTPS origin. HTTPS cookies are automatically enabled on Vercel. The app does
not provide email verification or password reset; add those flows before
relying on it as a public production service.

MODULES
1. Account-based overview and battery profile
2. Battery information (temperature, cycles, fast-charge %, C-rate,
   velocity and road gradient)
3. Capacity-fade calculations and 80% threshold
4. Weibull reliability, hazard, B10/B50 and scale sensitivity
5. 10,000-sample Monte Carlo simulation
6. Validation metrics and residual diagnostics

SCIENTIFIC SCOPE
No fitted equations, coefficients, or experimental dataset were provided
with this project. The website therefore does not invent defaults or present
sample observations as research results. Enter parameters calibrated for your
study before interpreting any model output.

The degradation module uses the transparent linear relationship:
    SoH(cycles) = initial SoH - fade rate (%) * cycles / 1000
Replace this equation in app.js if your research uses a different model.

The Weibull module uses:
    R(t) = exp(-(t / eta)^beta)
    h(t) = (beta / eta) * (t / eta)^(beta - 1)
    Bq = eta * (-ln(1-q))^(1/beta)

Monte Carlo samples come from the configured Weibull distribution; they are
not predictions from a trained machine-learning model. Validation metrics
use the observed and predicted values entered by the account holder. The K-S
statistic is descriptive; no p-value is claimed for a reference distribution
whose parameters were estimated from the same sample. AIC is not applicable
to arbitrary observed/predicted pairs.

FILES
- index.html : website structure and account form
- styles.css : responsive design
- app.js     : browser calculations and account workspace client
- server.js  : Express API and password authentication
- database.js: SQLite local / Neon Postgres storage adapter
- api/[...route].js : Vercel serverless API entry
- vercel.json: Vercel function configuration
- scripts/migrate-sqlite-to-neon.js : optional existing-data migration
- package.json : runtime dependencies and start command

Use HTTPS in production; do not treat a local development server as a hosted
service.
