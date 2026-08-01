# Kelo Cola — Frontend + Backend

## What changed from the prototype
- Sign up and Log in are now **two separate modal elements** (`#signupOverlay` / `#loginOverlay`) with their own forms, not one form with fields toggled by a tab.
- Nothing on the dashboard or in the stats sections is hardcoded anymore — it's all fetched from the backend:
  - Hero "Total backers" number, the bottle caption, and the category counts in the Backers section come from `GET /api/stats`, computed from real signups.
  - The dashboard (shares, amount backed, projected value, growth bars, perks) comes from `GET /api/dashboard` or the response of `POST /api/back`, based on the logged-in user's real data.
  - Because the backend starts with an empty in-memory store, the site will show **0 backers** until people actually sign up and back a tier — the old "6,140 backers" was placeholder marketing copy, this is live data.
- Password fields were added (the original form had none).
- A basic `logout()` was added.

## Run the backend
```bash
cd backend
npm install
npm start        # or: npm run dev (auto-restarts on file changes)
```
Runs on `http://localhost:4000` by default. Override with `PORT` and set a real `JWT_SECRET` env var for anything beyond local testing.

## Run the frontend
Just open `frontend/index.html` in a browser, or serve the folder with any static server, e.g.:
```bash
cd frontend
npx serve .
```
`script.js` has `const API_BASE = 'http://localhost:4000'` at the top — change this if your backend runs somewhere else.

## Endpoints
| Method | Path              | Auth | Purpose |
|--------|-------------------|------|---------|
| POST   | `/api/signup`     | no   | Create an account → returns `{ token, user }` |
| POST   | `/api/login`      | no   | Log in → returns `{ token, user }` |
| POST   | `/api/back`       | yes  | Back a tier (`{ tierName }`) → returns updated `user` |
| GET    | `/api/dashboard`  | yes  | Get the logged-in user's current backer data |
| GET    | `/api/stats`      | no   | Real, site-wide backer totals by category |

Auth is a `Bearer <token>` JWT in the `Authorization` header, issued on signup/login and stored in the browser's `localStorage` as `keloToken`.

## Before this touches real users or real money
- Swap the in-memory `Map` in `server.js` for a real database — everything is lost on server restart right now.
- Use a real, secret `JWT_SECRET` from an environment variable, not the default fallback in the code.
- Put this behind HTTPS.
- Given the "backer shares + possible future revenue-share + growth projections" framing, it's worth having someone with securities/consumer-protection expertise in Nigeria review whether this could be read as an investment offering — the disclaimers help, but they may not be sufficient on their own.


/-----------------------
next implementations 
------------------------/


[1]✅
on the click of a  particular share to be bought a stripe page should pop up( DEMO{simulated})where payments will be made through, only until after payment will the users dashboard show that he is a backer and show his backer dashboard info


[2]✅
also complete the ui and modal status for the payment modal overlay before redirection                          

[3]✅
if a backer decides to buy more than one set of shares it should show him multiple tiles in his dashboard with the different tiers or even if it is the same tier it should show the multiple shares he has on different cards or tiles
and also total amount of shares and the total amount of expected assets per 7 days up to a month


[4] ✅
write a postgresql sql to populate a table users with the following columns :- id, name, email, phone, password, backer_number, created_at
fill it up with 1,000 users 


[5]
WITHDRAWiNG funds
to be able to withdraw funds users depending on the baacking tier they take on have amount of days eligible for them to be able to withdraw their money with a minimun of 4 days for the highest tier of N150,000 and 14 days for the lower tier of N5,00
if the user has multiple tiers his least days should be taken upon by the max tier which should have the least amount of days to withdraw 

if a user clicks on withdraw it should show how much has accumulated for him based on the growth curve based on how long ago the user backed the  tier:- There should be a visible timer there for the user to see how long he has till he has his money, whilst the go to withdrawal page button should be grey until the said day(the timer should be run on the backend to avoid tampering ): the timer interface should show the time remaining in this format: days, hours, minutes, seconds, and it should start counting on the backend as soon as the user backs a tier and should adjust if he has backed a shorter time tier


[6] Free tier

[7]info mail