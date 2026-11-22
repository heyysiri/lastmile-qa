import { auth } from '@clerk/nextjs/server';

export async function readClerkUserId(): Promise<string | null> {
  return (await auth()).userId;
}
