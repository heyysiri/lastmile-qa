import { StartSession } from '../../components/StartSession';
import { InventoryForm } from '../../components/InventoryForm';
import { currentState } from '../../lib/session';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Inventory · Seller Hub' };

export default async function Inventory() {
  const state = await currentState();
  return (
    <>
      <h1>Inventory</h1>
      <p className="lede">Keep stock counts accurate so shoppers only order what you have.</p>
      {state ? <InventoryForm initial={state.inventory} /> : <StartSession fixtureId="active-seller" description="Start a demo session to get an active seller with a store and one product." />}
    </>
  );
}
