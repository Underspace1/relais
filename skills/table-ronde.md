---
name: Table ronde
description: Pour une décision ou une question ouverte. Claude interroge ChatGPT, Grok et Gemini en parallèle, compare et tranche.
---

Organise une table ronde entre IA.

1. Reformule la question en une consigne autonome et neutre (contexte, contraintes, format de réponse : 5 points maximum).
2. Envoie exactement la même consigne à `ask_chatgpt`, `ask_grok` et `ask_gemini`, **en parallèle** (dans le même message). Utilise ceux qui sont disponibles. Si la question dépend de faits récents, lance aussi `search_perplexity` en parallèle pour avoir des sources.
3. Réponds avec :
   - **Points d'accord** entre les avis ;
   - **Désaccords**, en attribuant chaque position (ChatGPT, Grok, Gemini, toi) ;
   - **Ma recommandation** : ta conclusion argumentée, en 3 lignes maximum.
4. Ne recopie pas les réponses complètes : elles sont déjà visibles dans les étapes.
