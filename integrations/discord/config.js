export const DISCORD_CLIENT_ID = '1555710706010165348';
export const LARGE_IMAGE_KEY = 'honya';
export const APP_NAME = 'Honya Desktop';

export const resolveClientId = (env = process.env) => String(env.HONYA_DISCORD_CLIENT_ID || DISCORD_CLIENT_ID || '').trim();
