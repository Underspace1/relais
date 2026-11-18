---
name: Table ronde
description: Pour une décision ou une question ouverte. Claude interroge ChatGPT et Grok en parallèle, compare et tranche.
---

Organise une table ronde entre IA.

1. Reformule la question en une consigne autonome et neutre (contexte, contraintes, format de réponse : 5 points maximum).
2. Envoie exactement la même consigne à `ask_chatgpt` et `ask_grok`, **en parallèle** (dans le même message). Si un seul outil est disponible, utilise-le seul.
3. Réponds avec :
   - **Points d'accord** entre les avis ;
   - **Désaccords**, en attribuant chaque position (ChatGPT, Grok, toi) ;
   - **Ma recommandation** : ta conclusion argumentée, en 3 lignes maximum.
4. Ne recopie pas les réponses complètes : elles sont déjà visibles dans les étapes.
