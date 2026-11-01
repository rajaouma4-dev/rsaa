export type SDUIComponent =
  | {type: 'text'; id: string; value: string; role?: 'title' | 'body' | 'caption'}
  | {type: 'button'; id: string; label: string; action: 'open_profile' | 'open_chats' | 'open_people'}
  | {type: 'card'; id: string; children: SDUIComponent[]};

export type SDUIScreen = {version: number; screen: string; theme: 'dark' | 'light'; components: SDUIComponent[]};

const ACTIONS = new Set(['open_profile', 'open_chats', 'open_people']);
const COMPONENTS = new Set(['text', 'button', 'card']);

export function validateSDUIScreen(value: unknown): value is SDUIScreen {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (v.version !== 1 || typeof v.screen !== 'string' || v.screen.length < 1 || v.screen.length > 60 || !['dark', 'light'].includes(String(v.theme)) || !Array.isArray(v.components)) return false;
  const ids = new Set<string>();
  let total = 0;
  const visit = (items: unknown[], depth = 0): boolean => {
    if (depth > 4 || items.length > 50) return false;
    return items.every(item => {
      total += 1;
      if (total > 200 || !item || typeof item !== 'object' || Array.isArray(item)) return false;
      const c = item as Record<string, unknown>;
      if (typeof c.id !== 'string' || c.id.length < 1 || c.id.length > 80 || ids.has(c.id) || !COMPONENTS.has(String(c.type))) return false;
      ids.add(c.id);
      if (c.type === 'text') {
        return typeof c.value === 'string' && c.value.length <= 3000 &&
          (c.role === undefined || ['title', 'body', 'caption'].includes(String(c.role)));
      }
      if (c.type === 'button') {
        return typeof c.label === 'string' && c.label.length >= 1 && c.label.length <= 80 && ACTIONS.has(String(c.action));
      }
      return c.type === 'card' && Array.isArray(c.children) && visit(c.children, depth + 1);
    });
  };
  return visit(v.components);
}

// Production must verify an Ed25519 signature over canonical JSON bytes before validation/rendering.
// This function intentionally fails closed until the native crypto verifier is integrated.
export async function verifySDUISignature(_canonicalJson: string, _signature: string, _publicKey: string): Promise<boolean> {
  return false;
}
