/** Clear pending writes before a different account mounts any workspace UI. */
export function selectBrowserWorkspace(storage: Storage, userId: string) {
  const ownerKey = 'lastmile-workspace-owner';
  if (storage.getItem(ownerKey) === userId) return;
  const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index));
  for (const key of keys) if (key?.startsWith('lastmile')) storage.removeItem(key);
  storage.setItem(ownerKey, userId);
}
