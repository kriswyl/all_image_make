const DARK = "101923", LIGHT = "FFFFFF";

function channels(color: string) {
  return [0, 2, 4].map(offset => parseInt(color.slice(offset, offset + 2), 16) / 255);
}
function luminance(color: string) {
  const [red, green, blue] = channels(color).map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * red! + 0.7152 * green! + 0.0722 * blue!;
}
function contrast(a: string, b: string) {
  const first = luminance(a), second = luminance(b);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}
export function presentationInk(background: string, preferred?: string) {
  if (preferred && contrast(background, preferred) >= 4.5) return preferred;
  return contrast(background, "000000") >= contrast(background, LIGHT)
    ? contrast(background, DARK) >= 4.5 ? DARK : "000000"
    : LIGHT;
}
export function presentationPanel(background: string) {
  const tint = channels(presentationInk(background));
  return channels(background).map((value, index) =>
    Math.round((value * 0.88 + tint[index]! * 0.12) * 255).toString(16).padStart(2, "0")).join("").toUpperCase();
}
