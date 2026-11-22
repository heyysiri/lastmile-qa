import { config as loadEnv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

loadEnv({ path: fileURLToPath(new URL('../../.env', import.meta.url)), quiet: true });

const config: NextConfig = {
  // Preserve 127.0.0.1: Clerk's self-rewrite otherwise becomes localhost and loops.
  skipProxyUrlNormalize: true,
  transpilePackages: ['@lastmile/contracts'],
  allowedDevOrigins: ['127.0.0.1'],
};
export default config;
