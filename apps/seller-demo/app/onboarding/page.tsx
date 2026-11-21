import { StartSession } from '../../components/StartSession';
import { StoreForm } from '../../components/StoreForm';
import { currentState } from '../../lib/session';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Store setup · Seller Hub' };

export default async function Onboarding() {
  const state = await currentState();
  const shortTimeout = process.env.SELLER_DEMO_DEFECT === 'short-save-timeout';
  return (
    <>
      <h1>Set up your store</h1>
      <p className="lede">Name your store so shoppers recognise it. Your details are saved to this demo's local database.</p>
      {shortTimeout && <p className="hint">Demo condition: short save timeout</p>}
      {state ? <StoreForm shortTimeout={shortTimeout} initialName={state.store?.name ?? ''} initialStatus={state.store?.status ?? null} /> : <StartSession fixtureId="fresh-seller" description="Start a demo session to get a new seller account with no store yet." />}
    </>
  );
}
