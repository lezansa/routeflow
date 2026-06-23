# RouteFlow — React

## Setup

```bash
npm install
npm run dev
```

Open http://localhost:5173

## Build for production

```bash
npm run build
npm run preview
```

## Structure

```
src/
  utils.js              — all geo math + routing API calls (pure functions)
  hooks/useNavigation.js — GPS tracking, voice instructions, step logic
  NavPanel.jsx          — navigation overlay component
  App.jsx               — main app: map, form, results
  App.css               — styles + dark mode
```

## Navigation

Tap **▶ Start Navigation** after generating a route. The app will:
- Track your GPS position with a blue dot on the map
- Speak each turn instruction aloud (Web Speech API, no key needed)
- Warn "In 200m, turn left" before you reach each turn
- Alert you if you go off route

Works best on mobile (iOS Safari, Android Chrome). Requires location permission.
