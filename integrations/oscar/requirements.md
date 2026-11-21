# Reviewed acceptance requirements for the Oscar integration

This integration tests the pinned upstream Django Oscar application, not a replacement UI. Source: https://github.com/django-oscar/django-oscar, release 4.2.1, commit d0a70850abf8e4229d4971aa7e8f4643326ec9f3 (BSD license).

A customer can edit their first name using the existing account profile form. Saving a profile must preserve the customer's current basket quantities, saved delivery addresses and order history. A first name is nonblank text up to 150 characters. Do not change their email or password during this task.

A customer can update the quantity of the existing Trail travel mug in their basket through the existing basket form. The saved quantity must equal the requested whole number from 1 to 99. Updating a basket must preserve profile details and existing orders. The app has catalogue, search, checkout, shipping, vouchers, orders, reviews, wishlists and a management dashboard; this checkpoint does not claim full coverage of these modules.

The returning-customer fixture starts with four mugs in its basket; the new-customer fixture starts with one. Those are known initial conditions, not claimed observed past journeys. Subsequent recorded journeys form actual tester history. Customers are isolated by real Oscar user and basket records.

The optional reset-basket-on-profile-save regression is deliberately injected in a local copy of ProfileUpdateView for verification. It is not an upstream Oscar defect. With the flag enabled, a profile save resets each basket line to one. An actual code repair must preserve basket state with that same flag still enabled; toggling it off is not a repair.

Snapshot coverage: user profile, open basket lines and delivery addresses. Accounts with orders are refused for checkpoint cloning until order snapshot support exists. No real payments, outbound email, production credentials or external integrations.
