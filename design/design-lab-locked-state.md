# design-lab — état verrouillé (baseline pré-V1.2)

Snapshot de l'état du panneau de contrôle `design-lab` (http://localhost:5174,
`design-lab/index.html` + `design-lab/main.js`) capturé le 2026-07-17, avant la
migration vers V1.2. Ces valeurs sont désormais les **défauts codés en dur**
dans `design-lab/index.html` (attributs `checked`) et `design-lab/main.js`
(valeurs initiales des sliders) — reproductibles simplement en rechargeant la
page, sans dépendre d'un état de navigateur éphémère (le panneau n'a aucune
persistance : ni `localStorage`, ni query params).

## Calques (checkboxes)

| Calque                  | État     |
|--------------------------|----------|
| logo                     | ✅ ON    |
| menu                     | ❌ OFF   |
| terrain                  | ✅ ON    |
| poutres                  | ✅ ON    |
| bordures buts            | ✅ ON    |
| score                    | ❌ OFF   |
| tableau score bois       | ✅ ON    |
| lignes                   | ✅ ON    |
| limites physiques        | ❌ OFF   |
| constellation            | ✅ ON    |
| bubbles                  | ✅ ON    |
| identicon dans hexagone  | ❌ OFF   |

## Bubbles

- version : **V4**
- intégration bubbles (blend) : **0.21**

## Sliders terrain / poutres / logo

- noirceur (lignes) : **0.51**
- fondu glace poutre (tail alpha) : **1.00**
- position du fade (tail decay) : **8.0**
- logo horizontal : **12.0**

## Bug corrigé pendant ce verrouillage

Le toggle `limites physiques` masquait `#ui-physics-bounds` via
`display:none`, mais `alignPoutresToPhysics()`, `alignBorduresButs()` et
`alignScoreboardWood()` (`design-lab/main.js`) lisent toutes le
`getBoundingClientRect()` de cet élément comme référence de positionnement —
le masquer à `display:none` mettait son rect à zéro et cassait le
positionnement des poutres, des bordures de buts et du tableau de score dès
que la checkbox était décochée par défaut. Corrigé en togglant `opacity`
plutôt que `display` pour ce calque uniquement (l'élément reste dans le flux
et garde un rect réel, tout en étant invisible — il était déjà
`pointer-events:none`).

Corrigé aussi : les checkboxes de calque n'appliquaient leur visibilité qu'au
`change`, jamais à l'initialisation — un calque décoché par défaut dans le
HTML restait quand même visible tant que l'utilisateur n'avait pas cliqué
dessus une fois. Chaque toggle applique maintenant son état au chargement.

Même bug sur le slider `logo horizontal` : `logoEl.style.left` n'était posé
que dans le listener `input` du slider, jamais à l'initialisation — changer
`LOGO_LEFT` dans le code ne déplaçait donc pas le logo tant qu'on n'avait pas
touché le slider à la main. Corrigé en appliquant `style.left` dès le
chargement ; le défaut CSS de `#ui-logo` (`design-lab/index.html`) est aussi
remonté à 12% pour rester cohérent.
