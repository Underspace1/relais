/**
 * Comprend une demande écrite simplement et devine quelle IA aider.
 * Partagé entre le serveur (pour guider Claude) et l'interface (pour l'aperçu).
 *
 *   « fais-moi un logo pour mon jeu »         → image via ChatGPT
 *   « demande à grok ce qu'il en pense »      → avis de Grok
 *   « compare l'avis de chatgpt et grok »     → table ronde
 *   « @grok une image de dragon »             → image via Grok
 */

const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[’`]/g, "'");

const IMAGE_NOUN = /\b(images?|illustrations?|dessins?|logos?|icones?|miniatures?|thumbnails?|affiches?|posters?|visuels?|wallpapers?|fonds? d'ecran|concept ?arts?|sprites?|photos?|portraits?|bannieres?|banners?|textures?|skins?|artworks?|emojis?|stickers?|cartes? postales?)\b/;
const IMAGE_VERB = /\b(dessine|dessiner|illustre|genere|generer|cree|creer|fais|faire|fait|produis|imagine|refais|redessine|montre[- ]moi|peux-tu|tu peux|j'aimerais|je veux|je voudrais|donne[- ]moi|draw|generate|make|create)\b/;
const QUESTION = /^(comment|pourquoi|c'est quoi|qu'est-ce|quel|quelle|quels|quelles|est-ce que|combien|ou |explique|how|why|what)\b/;
const ASK = /\b(demande|demander|pose la question|avis|qu'en pense|que pense|consulte|interroge|vois avec|verifie avec|selon|ask)\b/;
const BOTH = /\b(les deux|compare|comparer|comparaison|debat|debattre|table ronde|tous les deux|chacun|vs|versus)\b/;
const CODE = /\b(script|scripts|code|luau|lua|bug|erreur|fonction|module|fichier|remoteevent|datastore|programme|coder)\b/;

const GPT = /(@chatgpt|@gpt|\bchat ?gpt\b|\bopenai\b|\bgpt\b|\bcodex\b|\bdall-?e\b)/;
const GROK = /(@grok|\bgrok\b|\bxai\b)/;
const ROBLOX = /\b(roblox|obby|tycoon|simulator|mon jeu|du jeu|pour le jeu|game pass)\b/;
const DESIGN = /(@design\b|\b(maquettes?|mockups?|prototypes?|wireframes?|landing( page)?|page web|site web|site vitrine|interfaces?|ui|ux|hud|ecran (d'accueil|de jeu|de menu|titre)|menu (du jeu|principal|de jeu)|boutique du jeu|slides?|diapos?|presentation|one-pager|dashboard|tableau de bord|charte graphique|design system)\b)/;
const CRITIQUE = /\b(critique|critiquer|avis sur (le|mon|ce) design|revois (le|mon) design|audit (ux|ui|d'accessibilite)|accessibilite)\b/;

/**
 * @returns {{ relay: string|null, label: string, chain: string[], explicit: boolean, engines: string[], kind: string|null }}
 */
export function detectIntent(text) {
  const t = norm(text).trim();
  const none = { relay: null, label: '', chain: [], explicit: false, engines: [], kind: null };
  if (t.length < 3) return none;

  const gpt = GPT.test(t);
  const grok = GROK.test(t);
  const explicit = /@(chatgpt|gpt|grok|image|design)\b/.test(t);
  const draws = /\b(dessine|dessiner|redessine|illustre|peins|peindre|draw|paint)\b/.test(t);
  const wantsImage = (/@image\b/.test(t) || draws || (IMAGE_NOUN.test(t) && (IMAGE_VERB.test(t) || !QUESTION.test(t)))) && !QUESTION.test(t.replace(/^@\w+\s*/, ''));
  const both = (gpt && grok) || BOTH.test(t);
  const strongImage = /\b(images?|dessins?|illustrations?|photos?|logos?|wallpapers?|artworks?|dessine)\b/.test(t) && !/@design\b/.test(t);
  const design = DESIGN.test(t) && !gpt && !grok && !strongImage && (/@design\b/.test(t) || IMAGE_VERB.test(t) || /\b(concois|concevoir|maquette|prototype|refais|ameliore)\b/.test(t) || !QUESTION.test(t));

  if (design && CRITIQUE.test(t)) return { relay: 'design-critique', label: 'Critique de design', chain: ['claude'], explicit: /@design\b/.test(t), engines: [], kind: 'design' };
  if (design) {
    const robloxUi = /\b(hud|boutique du jeu|menu (du jeu|de jeu|principal)|ecran (de jeu|de menu|titre))\b/.test(t) || (ROBLOX.test(t) && /\b(interfaces?|ui|menus?|ecrans?|boutique|inventaire|gui)\b/.test(t));
    return robloxUi
      ? { relay: 'design-roblox-ui', label: 'UI de jeu Roblox', chain: ['claude'], explicit: /@design\b/.test(t), engines: [], kind: 'design' }
      : { relay: 'design', label: 'Maquette interactive', chain: ['claude'], explicit: /@design\b/.test(t), engines: [], kind: 'design' };
  }

  if (wantsImage) {
    if (gpt && grok) return { relay: 'image-both', label: 'Image par ChatGPT et Grok', chain: ['claude', 'chatgpt', 'grok'], explicit, engines: ['chatgpt', 'grok'], kind: 'image' };
    if (grok) return { relay: 'image-grok', label: 'Image par Grok', chain: ['claude', 'grok'], explicit, engines: ['grok'], kind: 'image' };
    if (ROBLOX.test(t) && /\bicones?\b/.test(t)) return { relay: 'roblox-icon', label: 'Icône de jeu par ChatGPT', chain: ['claude', 'chatgpt'], explicit, engines: ['chatgpt'], kind: 'image' };
    if (/\b(miniatures?|thumbnails?)\b/.test(t)) return { relay: 'roblox-thumb', label: 'Miniature par ChatGPT', chain: ['claude', 'chatgpt'], explicit, engines: ['chatgpt'], kind: 'image' };
    return { relay: 'image-chatgpt', label: 'Image par ChatGPT', chain: ['claude', 'chatgpt'], explicit, engines: ['chatgpt'], kind: 'image' };
  }
  if (both && (gpt || grok || BOTH.test(t)) && (ASK.test(t) || BOTH.test(t))) {
    return { relay: 'debate', label: 'Avis de ChatGPT et Grok', chain: ['chatgpt', 'grok', 'claude'], explicit, engines: ['chatgpt', 'grok'], kind: 'ask' };
  }
  if (grok && (ASK.test(t) || explicit)) return { relay: 'ask-grok', label: 'Avis de Grok', chain: ['claude', 'grok'], explicit, engines: ['grok'], kind: 'ask' };
  if (gpt && (ASK.test(t) || explicit)) return { relay: 'ask-chatgpt', label: 'Avis de ChatGPT', chain: ['claude', 'chatgpt'], explicit, engines: ['chatgpt'], kind: 'ask' };
  if (ROBLOX.test(t) && CODE.test(t)) return { relay: 'roblox-script', label: 'Script Roblox', chain: ['claude'], explicit: false, engines: [], kind: 'code' };
  return none;
}

/** Retire les @mentions du texte envoyé aux IA. */
export function stripMentions(text) {
  return String(text || '').replace(/(^|\s)@(chatgpt|gpt|grok|image|design|claude)\b/gi, '$1').replace(/\s{2,}/g, ' ').trim();
}
