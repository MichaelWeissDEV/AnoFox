// Approach 1: plain JS getter replacement in the page's own (MAIN) world.
(() => {
  const proto = Navigator.prototype;
  const def = (name, value) => {
    const orig = Object.getOwnPropertyDescriptor(proto, name);
    Object.defineProperty(proto, name, { get() { return value; }, set: orig.set, enumerable: orig.enumerable, configurable: orig.configurable });
  };
  def('hardwareConcurrency', 4);
  def('userAgent', 'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0');
  def('platform', 'Linux x86_64');
  def('languages', Object.freeze(['en-US', 'en']));
  def('language', 'en-US');
})();
