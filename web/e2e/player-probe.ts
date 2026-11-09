// Exposes the Player to a test page (bundled by e2e/run.mjs).
import { Player } from '../src/audio/player';
(window as unknown as { Player: typeof Player }).Player = Player;
