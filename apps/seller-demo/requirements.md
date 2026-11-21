# Seller Hub requirements

- A seller can save a store profile with a non-empty store name of at most 80 characters after trimming whitespace. A successful save sets the store status to ready.
- A seller can update a listed product's stock to a whole number between 0 and 1,000,000, inclusive. The saved quantity remains visible after reopening the account.
- Editing a store profile must not change stock. Every product's saved inventory quantity must remain equal to its value immediately before the edit.
- A seller's store profile and inventory belong to that seller's account. Changes must affect only the signed-in account.
