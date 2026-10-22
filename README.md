# EcoSmart 2.0

EcoSmart is a full-stack e-waste pickup, tracking and rewards project.

## What was upgraded

- Node.js backend with SQLite database
- Secure password hashing using Node's built-in `scrypt`
- Token-based authentication
- User accounts and persistent pickup history
- Pickup requests with multiple e-waste items
- Photo upload/storage for admin verification
- Area-based pickup slots
- Admin approval → agent assignment → collection → recycling workflow
- Automatic EcoPoints after recycling
- Reward redemption and voucher codes
- Notifications
- Eco impact dashboard, levels and achievements
- Recycling certificate after completion
- Responsive mobile navigation
- Improved homepage, FAQ and recycling journey
- Demo collection-agent tracking visualization

## Requirements

- Node.js **22 or newer**
- A modern browser

No npm packages are required for the included backend. SQLite is provided by Node 22's built-in `node:sqlite` module.

## Run the project

Open a terminal in this folder and run:

```bash
npm start
```

Then open:

`http://localhost:3000`

Do **not** double-click the HTML files. The backend serves the pages and APIs.

## Demo admin account

Email: `admin@ecosmart.local`

Password: `Admin@123`

Change this before using the project publicly.

## Data

The SQLite database is created automatically at:

`data/ecosmart.db`

Uploaded pickup images are stored in:

`uploads/`

Both are ignored by Git by default.

## Important production notes

This is a strong college/demo full-stack build, but before a real public launch you should still add:

1. HTTPS and a strong `ECOSMART_TOKEN_SECRET` environment variable.
2. A real production database/server deployment.
3. Proper admin account provisioning instead of a seeded demo password.
4. Rate limiting, CSRF protection and stronger validation.
5. Cloud object storage for images.
6. A real authenticated collection-agent app for live GPS updates.
7. Real notification providers for email/SMS/push.
8. Privacy policy, terms, consent and data-retention rules.
9. Real reward partners and verified recycling/collection-centre information.
10. An AI e-waste classifier only after the core workflow is stable.

## Main API areas

- `/api/auth/*` — registration, login and current user
- `/api/pickups/*` — user pickup requests
- `/api/rewards/*` — rewards and redemption
- `/api/notifications` — user notifications
- `/api/dashboard` — impact/level/achievement data
- `/api/admin/*` — admin workflow
- `/api/certificate/latest` — latest recycling certificate
- `/api/public/impact` — homepage impact numbers

## Usability and safety enhancements in this update
- Added a post-submission packing and battery-safety modal on the pickup form.
- Added a full e-waste disposal and data-privacy guide (`guide.html`) with FAQs.
- Added pickup history search/status filters to the user dashboard.
- Added cancellation and rescheduling for pickup requests while they are still pending; assigned requests require contacting support.
- Added keyboard focus states, modal accessibility labels, and small-screen responsive layouts for the new components.

## Important implementation notes
- The dashboard impact score is an estimate, not a verified carbon-accounting result.
- AI image classification is not connected to a real model/API in this build; do not describe it as implemented until a model or AI service is integrated and tested.
- The existing admin panel assigns collection agents and updates pickup status. A separate agent login/portal would require a dedicated agent authentication and authorization workflow before public deployment.
- Before public launch, replace demo credentials, configure secure production secrets, add rate limiting and stronger upload validation, and use an authorized recycler/collection partner.
