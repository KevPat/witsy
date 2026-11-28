
// for text that ends up in a string rendered as markup, such as the title and html of a dialog
export const escapeHtml = (text: string): string => {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
