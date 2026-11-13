export const fail = code => Object.assign(new Error(code), { code });
export const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const errorCode = error => /^SKILLS_[A-Z0-9_]{1,80}$/u.test(error?.code) ? error.code :
  ['AbortError', 'TimeoutError'].includes(error?.name) ? 'SKILLS_TIMEOUT' : 'SKILLS_UNAVAILABLE';
