import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, errors, type BrowserContext, type BrowserContextOptions, type Locator, type Page, type Request } from 'playwright';
import { resolveExpected, type AppliedCapability, type ContextPack, type InputValue, type LocatorSpec, type StepEvent } from '@lastmile/contracts';
import { BrowserActionSchema, type BrowserAction, type RecordedAction } from '@lastmile/contracts/runtime';

type BrowserSessionOptions = {
  pack: ContextPack;
  inputs: Record<string, InputValue>;
  origin: string;
  cookie?: { name: string; value: string; path: string };
  storageState?: BrowserContextOptions['storageState'];
  allowedOrigins?: string[];
  redactValues?: string[];
  artifactDirectory: string;
  signal: AbortSignal;
  onStep: (step: StepEvent) => void;
};

export type BrowserSession = {
  page: Page;
  execute(action: BrowserAction): Promise<string>;
  observe(): Promise<string>;
  refreshObservation(): Promise<string>;
  inspectReplayPosition(): Promise<{url:string;focus:string}>;
  actions: RecordedAction[];
  capabilities: AppliedCapability[];
  networkEvents: unknown[];
  storageState(): ReturnType<BrowserContext['storageState']>;
  close(): Promise<void>;
};

export class BrowserActionError extends Error {}

function allowed(url: URL, origin: string, extraOrigins: string[] = []) {
  if (!['http:', 'https:'].includes(url.protocol) || ![origin,...extraOrigins].includes(url.origin) || url.username || url.password) return false;
  let path = url.pathname;
  try {
    while (/%[0-9a-f]{2}/i.test(path)) path = decodeURIComponent(path);
    path = new URL(path.replace(/\\/g, '/').replace(/\/+/g, '/'), origin).pathname.toLowerCase();
    return !/^\/api\/test(?:[\/;]|$)/.test(path);
  } catch {
    return false;
  }
}

function cleanUrl(raw: string) {
  const url = new URL(raw);
  return url.origin === 'null' ? url.protocol : url.origin + url.pathname;
}

export function routeIdentity(raw: string): string {
  if (raw === 'blank') return raw;
  const url = new URL(raw.startsWith('/') ? 'http://route.invalid' + raw : raw);
  return url.pathname + url.search + url.hash;
}

function semanticLocator(page: Page, locator: LocatorSpec) {
  switch (locator.by) {
    case 'role':
      return page.getByRole(locator.value as Parameters<Page['getByRole']>[0], { name: locator.name, exact: true });
    case 'label': return page.getByLabel(locator.value, { exact: true });
    case 'text': return page.getByText(locator.value, { exact: true });
    case 'testId': return page.getByTestId(locator.value);
  }
}

export async function replayPosition(page:Page, redact = (value:string) => value):Promise<{url:string;focus:string}> {
  const focus=await page.locator(':focus').count()===1 ? await page.locator(':focus').evaluate(el=>({
    tag:el.tagName,role:el.getAttribute('role'),id:el.id,
    name:el.getAttribute('aria-label') || ('labels' in el ? Array.from((el as HTMLInputElement).labels || []).map(label=>label.textContent?.trim()).join(' ') : '') || (['BUTTON','A'].includes(el.tagName)?el.textContent?.trim():'')
  }),undefined,{timeout:1000}) : 'none';
  return {
    url: routeIdentity(page.url()),
    focus: typeof focus === 'string' ? focus : JSON.stringify({
      tag: redact(focus.tag), role: focus.role === null ? null : redact(focus.role), id: redact(focus.id), name: redact(focus.name),
    }),
  };
}

export async function createBrowserSession(options: BrowserSessionOptions): Promise<BrowserSession> {
  const { pack, inputs, artifactDirectory, signal, onStep } = options;
  const origin = new URL(options.origin).origin;
  const extraOrigins=(options.allowedOrigins??[]).map(value=>new URL(value).origin);
  const privateValues = (options.redactValues ?? []).filter(Boolean);
  const spellings = [...new Set(privateValues.flatMap(value => [value, JSON.stringify(value).slice(1,-1)]))]
    .sort((a, b) => b.length - a.length);
  const privatePattern = spellings.length
    ? new RegExp(spellings.map(value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g')
    : undefined;

  function containsPrivate(text: string) {
    if (!privateValues.length) return false;
    // Check escaped URL components, including form query values and nested encoding.
    for (let round = 0; round < 4; round++) {
      const formText = text.replaceAll('+', ' ');
      if (privateValues.some(value => text.includes(value) || formText.includes(value))) return true;
      const decoded = text.replace(/(?:%[0-9a-f]{2})+/gi, bytes => Buffer.from(bytes.replaceAll('%',''), 'hex').toString());
      if (decoded === text) return false;
      text = decoded;
    }
    return true;
  }

  function redact(text: string) {
    const result = privatePattern ? text.replace(privatePattern, '[private]') : text;
    return containsPrivate(result) ? '[private]' : result;
  }

  function redactEvidence(value: unknown): unknown {
    if (typeof value === 'string') return redact(value);
    if (typeof value === 'number' || typeof value === 'boolean') return containsPrivate(String(value)) ? '[private]' : value;
    if (Array.isArray(value)) return value.map(redactEvidence);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [redact(key), redactEvidence(item)]));
    }
    return value;
  }

  function requirePublicRoute(raw: string) {
    if (containsPrivate(raw)) throw new BrowserActionError('Browser route contains private account data and cannot be replayed');
  }
  const deadline = performance.now() + 180_000;
  const journeySignal = AbortSignal.any([signal, AbortSignal.timeout(180_000)]);
  if (signal.aborted) throw new BrowserActionError('Browser journey cancelled');
  await mkdir(artifactDirectory, { recursive: true });
  const browser = await chromium.launch({ timeout: 5_000 });
  let context: BrowserContext | undefined;
  try {
    const session = context = await browser.newContext({
      viewport: pack.viewport, locale: pack.locale, reducedMotion: pack.reducedMotion,
      serviceWorkers: 'block', acceptDownloads: false,
      storageState: options.storageState,
    });
    if(options.cookie) await session.addCookies([{ ...options.cookie, domain: new URL(origin).hostname, httpOnly: true }]);

    const actions: RecordedAction[] = [];
    const networkEvents: unknown[] = [];
    const network: AppliedCapability = {
      factor: 'network', status: pack.network.mode === 'normal' ? 'applied' : 'not_exercised',
      value: redactEvidence({ ...pack.network, matchedRequests: 0 }),
    };
    const capabilities: AppliedCapability[] = [
      { factor: 'viewport', status: 'applied', value: redactEvidence(pack.viewport) },
      { factor: 'locale', status: 'applied', value: redact(pack.locale) },
      { factor: 'reducedMotion', status: 'applied', value: pack.reducedMotion },
      { factor: 'interaction', status: 'applied', value: pack.interaction },
      network,
      { factor: 'inputs', status: Object.values(inputs).some(value => typeof value === 'object') ? 'unsupported' : 'applied', value: redactEvidence(inputs) },
      { factor: 'preferredLanguage', status: 'guidance_only', value: redact(pack.preferredLanguage) },
      { factor: 'familiarity', status: 'guidance_only', value: redactEvidence({ familiarity: pack.familiarity, knownTerms: pack.knownTerms }) },
    ];
    if (privateValues.length) {
      capabilities.push({ factor: 'screenshots', status: 'unsupported', value: 'Suppressed for private account data' });
    }

    const page = await session.newPage();
    await session.routeWebSocket(/.*/, socket => {
      const url=new URL(socket.url());
      url.protocol=url.protocol==='wss:'?'https:':'http:';
      if(allowed(url,origin,extraOrigins))socket.connectToServer();
      else void socket.close();
    });
    session.on('page', popup => { if (popup !== page) void popup.close().catch(() => {}); });
    let matchedRequests = 0;
    const pending = new Set<Request>();
    session.on('request', request => pending.add(request));
    session.on('requestfinished', request => pending.delete(request));
    session.on('requestfailed', request => {
      pending.delete(request);
      networkEvents.push({ kind: 'transport_failure', url: redact(cleanUrl(request.url())), method: redact(request.method()) });
    });
    session.on('response', response => {
      if (response.status() >= 400) {
        networkEvents.push({ kind: 'http_error', url: redact(cleanUrl(response.url())), method: redact(response.request().method()), status: response.status() });
      }
    });

    async function delayRequest(url: URL) {
      const profile = pack.network;
      if (profile.mode !== 'request_delay' || !url.pathname.startsWith(profile.pathPrefix)) return;
      const started = performance.now();
      await delay(profile.delayMs, undefined, { signal: journeySignal });
      network.status = 'applied';
      network.value = redactEvidence({ ...profile, matchedRequests: ++matchedRequests });
      networkEvents.push({ kind: 'request_delay', url: redact(cleanUrl(url.href)), delayMs: profile.delayMs, elapsedMs: Math.round(performance.now() - started) });
    }

    await session.route('**/*', async route => {
      const request = route.request();
      const url = new URL(request.url());
      try {
        if (journeySignal.aborted || request.frame().page() !== page || !allowed(url, origin,extraOrigins)) {
          await route.abort('blockedbyclient');
          return;
        }
        await delayRequest(url);
        await route.continue();
      } catch {
        await route.abort('blockedbyclient').catch(() => {});
      }
    });

    // Playwright routes handle the initial request only. Inspect each Chromium
    // redirect response before its Location can trigger another request.
    const cdp = await session.newCDPSession(page);
    cdp.on('Fetch.requestPaused', async event => {
      const location = event.responseHeaders?.find(header => header.name.toLowerCase() === 'location')?.value;
      const redirect = event.responseStatusCode && [301, 302, 303, 307, 308].includes(event.responseStatusCode);
      try {
        if (redirect && location) {
          const destination = new URL(location, event.request.url);
          if (!allowed(destination, origin,extraOrigins)) {
            await cdp.send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'BlockedByClient' });
            return;
          }
          await delayRequest(destination);
        }
        await cdp.send('Fetch.continueRequest', { requestId: event.requestId });
      } catch {
        await cdp.send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'BlockedByClient' }).catch(() => {});
      }
    });
    await cdp.send('Fetch.enable', { patterns: [{ requestStage: 'Response' }] });

    let index = 0;
    let busy = false;
    let observed: Locator | undefined;
    let closing: Promise<void> | undefined;

    function recordableUrl() {
      const url = page.url();
      requirePublicRoute(url);
      if (url !== 'about:blank' && !allowed(new URL(url), origin)) {
        throw new BrowserActionError('Browser reached a blocked location');
      }
      return url;
    }

    async function inspectReplayPosition() {
      const position = await replayPosition(page, redact);
      return { ...position, url: routeIdentity(recordableUrl()) };
    }

    async function saveScreenshot(name: string, timing: {timeout:number;signal?:AbortSignal}) {
      // An app can draw account strings into images, canvas, or closed shadow roots.
      // Suppress these screenshots before capture because DOM masks cannot cover those pixels.
      if (privateValues.length) return false;
      await page.screenshot({
        ...timing, path: join(artifactDirectory, name),
        mask: page.frames().map(frame => frame.locator('input[type="password" i]')),
      });
      return true;
    }

    function scalar(value: Parameters<typeof resolveExpected>[0]) {
      let resolved: InputValue;
      try { resolved = resolveExpected(value, inputs); }
      catch { throw new BrowserActionError('Unknown input slot. Available slot names: ' + redact(Object.keys(inputs).join(', '))); }
      if (typeof resolved === 'object') throw new BrowserActionError('A file fixture cannot be entered as text');
      return String(resolved);
    }

    async function target(spec: LocatorSpec) {
      const locator = semanticLocator(page, spec);
      if (await locator.count() !== 1 || !await locator.isVisible()) {
        throw new BrowserActionError('Locator must match one unique visible control');
      }
      if (!observed || await locator.and(observed).count() !== 1) {
        throw new BrowserActionError('Locator must match an observed control. Observe the page again.');
      }
      return locator.and(observed);
    }

    async function dispatch(action: BrowserAction, timing: { timeout: number; signal: AbortSignal }) {
      const keyboard = pack.interaction === 'keyboard_only';
      if (keyboard && ['click', 'select', 'scroll', 'uploadFixture'].includes(action.tool)) {
        throw new BrowserActionError('Action is unavailable in keyboard-only mode');
      }
      switch (action.tool) {
        case 'navigate': {
          const path = action.path;
          const url = new URL(path, origin);
          if (!/^\/(?!\/)[^\\]*$/.test(path) || !allowed(url, origin)) {
            throw new BrowserActionError('Navigation is outside the approved routes');
          }
          requirePublicRoute(url.href);
          await page.goto(url.href, { ...timing, waitUntil: 'domcontentloaded' });
          break;
        }
        case 'click': await (await target(action.locator)).click(timing); break;
        case 'fill': {
          const value = scalar(action.value);
          const locator = await target(action.locator);
          if (keyboard) {
            const focused = locator.and(page.locator(':focus'));
            if (await focused.count() !== 1 || !await focused.isEditable(timing)) {
              throw new BrowserActionError('Keyboard fill requires a focused editable control');
            }
            await page.keyboard.press('ControlOrMeta+A');
            timing.signal.throwIfAborted();
            if (await focused.count() !== 1) throw new BrowserActionError('Keyboard fill lost focus');
            if (!value) await page.keyboard.press('Backspace');
            for (const character of value) {
              timing.signal.throwIfAborted();
              if (await focused.count() !== 1) throw new BrowserActionError('Keyboard fill lost focus');
              await page.keyboard.type(character);
            }
          } else {
            await locator.fill(value, timing);
          }
          break;
        }
        case 'select': {
          const locator = await target(action.locator);
          const option = scalar(action.value);
          await locator.selectOption(option, timing);
          break;
        }
        case 'pressKey': await page.keyboard.press(action.key); break;
        case 'scroll': await page.mouse.wheel(0, action.direction === 'up' ? -action.pixels : action.pixels); break;
        case 'uploadFixture': throw new BrowserActionError('Fixture upload is unsupported until files are registered');
      }
    }

    async function snapshot(timing:{timeout:number;signal:AbortSignal}) {
      const url = recordableUrl();
      const focusRef = await page.locator(':focus').count() === 1
        ? await page.locator(':focus').ariaSnapshot({ depth: 1, ...timing }) : '';
      const snapshot = redact(await page.ariaSnapshot({ mode: 'ai', ...timing })).slice(0, 16_000);
      const refs = snapshot.split('\n').flatMap(line => {
        const ref = /\[ref=((?:f\d+)?e\d+)\]/.exec(line)?.[1];
        return ref && !line.includes('[aria-hidden]') ? [page.getByRef(ref)] : [];
      });
      observed = refs.reduce<Locator | undefined>((locators, ref) => locators ? locators.or(ref) : ref, undefined);
      return 'URL: ' + redact(cleanUrl(url)) + '\nFocused: ' + (redact(focusRef).trim().split('\n')[0] || 'none') + '\n' + snapshot;
    }

    async function refreshObservation() {
      if(busy||closing||page.isClosed())throw new BrowserActionError('Browser observation is unavailable');
      journeySignal.throwIfAborted();
      busy=true;
      try {
        const timeout=Math.max(1,Math.min(5000,Math.ceil(deadline-performance.now())));
        return await snapshot({timeout,signal:AbortSignal.any([journeySignal,AbortSignal.timeout(timeout)])});
      } finally {busy=false;}
    }

    async function step(action?: BrowserAction) {
      if (signal.aborted) throw new BrowserActionError('Browser journey cancelled');
      if (journeySignal.aborted) throw new BrowserActionError('Browser journey time limit reached');
      if (closing || page.isClosed()) throw new BrowserActionError('Browser session is closed');
      if (busy) throw new BrowserActionError('Browser tools must run sequentially');
      if (index >= 40) throw new BrowserActionError('Browser action budget exhausted');
      const seq = ++index;
      const timestamp = new Date().toISOString();
      const end = Math.min(deadline, performance.now() + 5_000);
      const remaining = () => Math.max(1, Math.ceil(end - performance.now()));
      const stepSignal = AbortSignal.any([journeySignal, AbortSignal.timeout(remaining())]);
      const timing = () => ({ timeout: remaining(), signal: stepSignal });
      const image = `step-${seq}.png`;
      let screenshot: string | undefined;
      let observation = 'Browser action could not be completed';
      let failure: BrowserActionError | undefined;
      let before:{url:string;focus:string}|undefined;
      let after: string | undefined;
      let stepArguments: BrowserAction | undefined;
      busy = true;
      let cancelStep: () => void = () => {};
      const work = (async () => {
        if (action) {
          if (action.tool === 'navigate') {
            requirePublicRoute(action.path);
          } else {
            const evidence = JSON.stringify(Object.entries(action).filter(([field]) => field !== 'tool'));
            if (redact(evidence) !== evidence) {
              throw new BrowserActionError('Browser action contains private account data. Use an input slot for account values.');
            }
          }
          stepArguments = action;
          before = await inspectReplayPosition();
          await dispatch(action, timing());
        }
        // Give UI updates a brief window, extending it for pending delayed requests.
        const settleUntil = Math.min(end - 400, performance.now() + (pack.network.mode === 'request_delay' ? pack.network.delayMs : 0) + 450);
        do {
          if (performance.now() + 100 > settleUntil) break;
          await delay(100, undefined, { signal: stepSignal });
        } while (pending.size);
        const result = await snapshot(timing());
        after = recordableUrl();
        return result;
      })();
      try {
        const cancelled = new Promise<never>((_, reject) => {
          cancelStep = () => {
            // Some keyboard/mouse operations do not accept a Playwright signal.
            void page.close().catch(() => {});
            reject(new BrowserActionError(signal.aborted ? 'Browser journey cancelled' : 'Browser action timed out'));
          };
          stepSignal.addEventListener('abort', cancelStep, { once: true });
          if (stepSignal.aborted) cancelStep();
        });
        try { observation = await Promise.race([work, cancelled]); }
        catch (error) {
          failure = error instanceof BrowserActionError ? error
            : new BrowserActionError(error instanceof errors.TimeoutError ? 'Browser action timed out' : 'Browser action could not be completed');
          observation = failure.message;
        }
        if (!stepSignal.aborted) {
          await saveScreenshot(image, timing())
            .then(saved => { if (saved) screenshot = image; }, () => {});
        }
        if (failure) throw failure;
        if (stepSignal.aborted) {
          failure = new BrowserActionError(signal.aborted ? 'Browser journey cancelled' : 'Browser action timed out');
          observation = failure.message;
          throw failure;
        }
        if (action && before && after) {
          // The absolute destination retains the source origin for storage-state rebinding.
          const recorded = { action, url: after, routeVersion: 2 as const, observation, urlBefore: before.url, focusBefore: before.focus };
          actions.push(recorded);
        }
        return observation;
      } finally {
        stepSignal.removeEventListener('abort', cancelStep);
        busy = false;
        onStep({ index: seq, timestamp, action: action?.tool ?? 'observe', arguments: stepArguments, observation, screenshot });
      }
    }

    return {
      page, actions, capabilities, networkEvents, refreshObservation, inspectReplayPosition,
      storageState:()=>session.storageState(),
      observe: () => step(),
      execute: async action => {
        const parsed = BrowserActionSchema.safeParse(action);
        if (!parsed.success) throw new BrowserActionError('Invalid browser action');
        return step(parsed.data);
      },
      close: () => closing ??= (async () => {
        let artifactError = false;
        try {
          if (!page.isClosed()) {
            await saveScreenshot('final.png', { timeout: 2_000 }).catch(() => { artifactError = true; });
          }
        } finally {
          try { await session.close(); }
          finally {
            await browser.close();
            await writeFile(join(artifactDirectory, 'network.json'), JSON.stringify(networkEvents, null, 2));
          }
        }
        if (artifactError) throw new BrowserActionError('Browser evidence could not be fully saved');
      })(),
    };
  } catch {
    try { await context?.close(); }
    finally { await browser.close(); }
    throw new BrowserActionError('Browser session could not be initialized');
  }
}
