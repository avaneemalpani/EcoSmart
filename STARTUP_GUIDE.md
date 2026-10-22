# EcoSmart: Startup prototype guide

## What changed
- Added a **For Organisations** page for colleges, offices, housing societies and other organisations that want bulk e-waste collection.
- Added a business enquiry form. Submissions are validated and saved in the SQLite database in `data/ecosmart.db`.
- Added an **Organisation enquiries** inbox in the Operations/Admin page. Sign in as the admin to review submitted leads.
- Updated the homepage to describe EcoSmart as a collection coordination platform and added a clear path for organisational customers.
- Kept individual pickup, user dashboard, pickup tracking and rewards features intact.

## Run locally
1. Install Node.js 22 or later.
2. Open this project folder in VS Code.
3. In the terminal run `npm start`.
4. Open `http://localhost:3000` in your browser. Do not open the HTML file directly or use Live Server for the full app; the API requires the Node server.
5. To view the admin operations page, sign in with `admin@ecosmart.local` and password `Admin@123` in this local demo. Change/remove demo credentials before any public deployment.

## Demonstration flow
1. Open Home and explain EcoSmart's problem and value proposition.
2. Click **For Organisations** and submit a sample college/company enquiry.
3. Sign in as admin and open **Operations**. Show the new enquiry in the Organisation enquiries inbox.
4. Explain that this is a lead/request, not a confirmed collection. The operations team would check quantity, location, logistics, pricing and an appropriate authorised recycler before confirming a service.
5. For the individual flow, register a normal user, request a pickup, and demonstrate the existing admin approval → agent assignment → collection → recycling status sequence.

## Business model (proposed, not yet commercially validated)
Potential revenue options include agreed collection/service fees, bulk collection contracts with institutions, recurring service plans, and negotiated revenue-sharing with authorised recycling partners. Do not claim any of these are already earning revenue. Validate costs and partner terms before quoting prices.

## Important prototype limitations
- The website does not yet have a real commercial recycling/collection partner integrated.
- The organisation form stores enquiries but does not send email/SMS notifications automatically.
- It does not charge customers or confirm appointments/contracts.
- GPS, rewards and recycling statuses should be described as prototype features unless connected to verified live services.
- Before a public launch, secure admin credentials, configure production secrets and hosting, add spam/rate protections, publish privacy terms, and confirm legal/operational requirements with authorised e-waste partners.
