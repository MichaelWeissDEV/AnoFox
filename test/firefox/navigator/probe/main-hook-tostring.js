// Approach 1b: MAIN world + patched Function.prototype.toString (itself a detectable change)
(() => {
  const proto = Navigator.prototype;
  const natives = new WeakMap();
  const origToString = Function.prototype.toString;
  const fakeToString = function toString() { return natives.has(this) ? natives.get(this) : origToString.call(this); };
  natives.set(fakeToString, origToString.call(origToString));
  Function.prototype.toString = fakeToString;
  const def = (name, value) => {
    const orig = Object.getOwnPropertyDescriptor(proto, name);
    const getter = { get [name]() { return value; } };
    const g = Object.getOwnPropertyDescriptor(getter, name).get;
    natives.set(g, origToString.call(orig.get));
    Object.defineProperty(proto, name, { get: g, set: orig.set, enumerable: orig.enumerable, configurable: orig.configurable });
  };
  def('hardwareConcurrency', 4);
  def('userAgent', 'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0');
  def('platform', 'Linux x86_64');
}) ();
