// Pure, chrome-free pre-flight used by panel.checkBind(). Kept free of any
// chrome.* / DOM access so the same-origin / login / in-scope decisions can be
// unit-tested without a browser-extension host. The deeper in-page adapter check
// (chrome.scripting.executeScript) still runs afterwards inside checkBind().
import { normalizeDocumentURL } from './profiles.js';

export const loginURL = (url) => {
  try { return /\/(?:login|logon|signin|sign-in|sso)(?:[./_-]|$)/i.test(new URL(url).pathname); }
  catch { return false; }
};

// Decides whether a saved task may be bound to (re-opened from) the current tab.
// Returns {ok:true} only for a same-origin, non-login, in-scope URL.
export function classifyBind(profile, currentUrl) {
  if (!profile) return { ok: false, reason: '该任务没有可用的识别规则，请重新识别' };
  if (!currentUrl) return { ok: false, reason: '无法读取当前标签页地址，请从手册页点击扩展' };
  let address;
  try { address = new URL(currentUrl); } catch { return { ok: false, reason: '当前标签页地址无效' }; }
  if (address.origin !== profile.origin) return { ok: false, reason: `请在手册来源 ${profile.origin} 的标签页点击扩展后再绑定（当前是 ${address.origin}）` };
  if (loginURL(address.href)) return { ok: false, reason: '当前页面是登录页，请先登录并打开手册章节页' };
  if (!normalizeDocumentURL(address.href, profile)) return { ok: false, reason: '当前页面不在该手册范围内（路径前缀或查询参数不符），请打开手册章节页' };
  return { ok: true };
}
