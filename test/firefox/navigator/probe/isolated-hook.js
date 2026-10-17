// Approach 2: ISOLATED content script using Firefox's Xray API (exportFunction / wrappedJSObject).
(() => {
  const win = window.wrappedJSObject;
  const proto = win.Navigator.prototype;
  const def = (name, value) => {
    const orig = Object.getOwnPropertyDescriptor(proto, name);
    const get = exportFunction(function () { return value; }, win);
    Object.defineProperty(proto, name, { get, set: orig && orig.set, enumerable: true, configurable: true });
  };
  def('hardwareConcurrency', 4);
  def('userAgent', 'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0');
  def('platform', 'Linux x86_64');
  def('language', 'en-US');
})();
