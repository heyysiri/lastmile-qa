import {test,expect} from '@playwright/test';
test('labeled short-timeout demo exposes a delayed save failure',async({page})=>{
 await page.goto('http://127.0.0.1:3001/onboarding');
 await page.getByRole('button',{name:'Start demo session'}).click();
 await page.getByLabel('Store name').fill('Siri Crafts');
 await page.route('**/api/store',async route=>{
  await new Promise(resolve=>setTimeout(resolve,1500));
  await route.continue().catch(()=>{});
 });
 await page.getByRole('button',{name:'Save store'}).click();
 await expect(page.getByRole('main').getByRole('alert')).toContainText('Could not reach the server');
 await expect(page.getByText('Demo condition: short save timeout')).toBeVisible();
});
