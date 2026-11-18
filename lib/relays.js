/**
 * Relais : des actions prêtes à l'emploi qui forcent une délégation précise.
 * Ex. « Image · ChatGPT » : Claude rédige le prompt, ChatGPT génère l'image.
 * Avec « direct », la demande part telle quelle, sans passer par Claude.
 */
export const RELAYS = [
  {
    id: 'image-chatgpt', group: 'Images', label: 'Image · ChatGPT', chain: ['claude', 'chatgpt'],
    hint: 'Claude écrit le prompt, ChatGPT dessine',
    kind: 'image', engine: 'chatgpt',
    instruction: 'L’utilisateur veut une image générée par ChatGPT. Rédige un prompt visuel détaillé en anglais à partir de sa demande, puis appelle generate_image avec engine "chatgpt". Ensuite, résume en deux lignes et propose deux variantes.',
  },
  {
    id: 'image-grok', group: 'Images', label: 'Image · Grok', chain: ['claude', 'grok'],
    hint: 'Rendu rapide et stylisé',
    kind: 'image', engine: 'grok',
    instruction: 'L’utilisateur veut une image générée par Grok. Rédige un prompt visuel détaillé en anglais, puis appelle generate_image avec engine "grok". Ensuite, résume en deux lignes.',
  },
  {
    id: 'image-both', group: 'Images', label: 'Comparer ChatGPT et Grok', chain: ['claude', 'chatgpt', 'grok'],
    hint: 'Le même prompt, deux moteurs',
    kind: 'agent',
    instruction: 'Rédige un seul prompt visuel en anglais, puis appelle generate_image deux fois EN PARALLÈLE : une avec engine "chatgpt", une avec engine "grok". Compare ensuite les deux résultats en trois lignes.',
  },
  {
    id: 'roblox-icon', group: 'Roblox', label: 'Icône de jeu', chain: ['claude', 'chatgpt'],
    hint: 'Carrée, lisible en tout petit',
    kind: 'image', engine: 'chatgpt', size: '1024x1024',
    instruction: 'Crée une icône de jeu Roblox (affichée en 512×512, souvent en tout petit). Prompt en anglais : un sujet central fort, silhouette lisible, couleurs saturées et contrastées, fond simple, PAS de texte, style 3D cartoon type Roblox. Appelle generate_image (engine "chatgpt", size "1024x1024"). Rappelle ensuite comment l’importer : Creator Hub → ton expérience → Places → Icon.',
  },
  {
    id: 'roblox-thumb', group: 'Roblox', label: 'Miniature 16:9', chain: ['claude', 'chatgpt'],
    hint: 'Pour la page du jeu',
    kind: 'image', engine: 'chatgpt', size: '1536x1024',
    instruction: 'Crée une miniature de jeu Roblox (16:9, 1920×1080 au final). Prompt en anglais : scène d’action dynamique, personnages style avatar Roblox, profondeur, éclairage vif, zone dégagée pour un éventuel titre. Appelle generate_image (engine "chatgpt", size "1536x1024"). Rappelle ensuite de la recadrer en 1920×1080 avant l’import.',
  },
  {
    id: 'roblox-script', group: 'Roblox', label: 'Script Luau', chain: ['claude'],
    hint: 'Charge le skill Roblox Luau',
    kind: 'agent', skill: 'roblox-luau',
    instruction: 'Charge le skill roblox-luau (use_skill), puis réponds. Si tu as accès aux fichiers du projet, écris-les directement.',
  },
  {
    id: 'design', group: 'Design', label: 'Maquette interactive', chain: ['claude'],
    hint: 'Aperçu live, comme Claude Design',
    kind: 'agent',
    instruction: 'Crée le design demandé avec show_design : un document HTML autonome, moderne et soigné (hiérarchie claire, espacements réguliers, typo choisie, vrais contenus plausibles, interactions simples en JS si c’est un prototype). Puis résume tes choix en trois lignes et propose deux variantes possibles. Pour toute retouche, renvoie le HTML complet avec le même design_id.',
  },
  {
    id: 'design-roblox-ui', group: 'Design', label: 'UI de jeu Roblox', chain: ['claude'],
    hint: 'Maquette puis code Luau',
    kind: 'agent',
    instruction: 'Conçois l’interface de jeu Roblox demandée (HUD, boutique, inventaire, menu…) : d’abord une maquette avec show_design au format 16:9 qui imite le rendu Roblox (gros boutons lisibles sur mobile, UICorner, UIStroke, couleurs vives, police type Gotham/Builder Sans). Ensuite, propose de la convertir en ScreenGui (structure des Frames/TextButtons, UIListLayout/UIGridLayout, tailles en Scale) et en LocalScript Luau.',
  },
  {
    id: 'design-critique', group: 'Design', label: 'Critique de design', chain: ['claude'],
    hint: 'Skill Claude Design',
    kind: 'agent', skill: 'design-critique',
    instruction: 'Charge le skill design-critique (use_skill) et suis-le pour critiquer le design ou la maquette dont parle l’utilisateur (s’il y a un design affiché plus haut, critique celui-là). Termine en proposant une version corrigée avec show_design.',
  },
  {
    id: 'ask-chatgpt', group: 'Avis', label: 'Demander à ChatGPT', chain: ['claude', 'chatgpt'],
    hint: 'Claude transmet et commente',
    kind: 'ask', engine: 'chatgpt',
    instruction: 'Transmets la demande à ChatGPT avec ask_chatgpt (consigne complète et autonome), puis présente sa réponse avec ton propre commentaire en deux ou trois lignes.',
  },
  {
    id: 'ask-grok', group: 'Avis', label: 'Demander à Grok', chain: ['claude', 'grok'],
    hint: 'Claude transmet et commente',
    kind: 'ask', engine: 'grok',
    instruction: 'Transmets la demande à Grok avec ask_grok (consigne complète et autonome), puis présente sa réponse avec ton propre commentaire en deux ou trois lignes.',
  },
  {
    id: 'debate', group: 'Avis', label: 'Table ronde', chain: ['chatgpt', 'grok', 'claude'],
    hint: 'Les deux répondent, Claude tranche',
    kind: 'agent', skill: 'table-ronde',
    instruction: 'Charge le skill table-ronde (use_skill) et suis-le : même consigne à ask_chatgpt et ask_grok en parallèle, puis synthèse et recommandation.',
  },
  {
    id: 'code-project', group: 'Code', label: 'Coder dans mon projet', chain: ['claude'],
    hint: 'Claude écrit directement les fichiers',
    kind: 'agent', skill: 'chef-de-projet-code',
    instruction: 'Charge le skill chef-de-projet-code (use_skill) et suis-le. Si tu as accès aux fichiers du projet, lis puis modifie-les directement ; sinon donne le code complet fichier par fichier et rappelle qu’on peut t’ouvrir le projet dans Réglages → Projet.',
  },
  {
    id: 'code-review', group: 'Code', label: 'Relecture croisée', chain: ['claude', 'chatgpt'],
    hint: 'ChatGPT relit le code de Claude',
    kind: 'agent',
    instruction: 'Écris ou récupère le code demandé, puis envoie-le à ask_chatgpt pour une relecture critique (bugs, sécurité, performance). Intègre les remarques pertinentes et donne la version finale.',
  },
];

export function getRelay(id) {
  return RELAYS.find((r) => r.id === id) || null;
}
