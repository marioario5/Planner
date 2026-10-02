const MIN_TOKEN_LENGTH = 16;

async function sha256(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}

/** Compares two strings without leaking where they first differ. */
async function safeEqual(a: string, b: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([sha256(a), sha256(b)]);
  let diff = 0;
  for (let i = 0; i < ha.length; i++) diff |= ha[i] ^ hb[i];
  return diff === 0;
}

/** A missing or too-short secret means the server is misconfigured; never run open. */
export function tokenConfigured(secret: string | undefined): secret is string {
  return typeof secret === 'string' && secret.length >= MIN_TOKEN_LENGTH;
}

export async function bearerMatches(request: Request, secret: string): Promise<boolean> {
  const header = request.headers.get('Authorization') ?? '';
  const match = /^Bearer (.+)$/i.exec(header);
  return match ? safeEqual(match[1], secret) : false;
}

export function tokenMatches(candidate: string, secret: string): Promise<boolean> {
  return safeEqual(candidate, secret);
}
