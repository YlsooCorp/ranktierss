require("dotenv").config();
const express = require("express");
const session = require("express-session");
const path = require("path");
const multer = require("multer");
const { createClient } = require("@supabase/supabase-js");
const cors = require("cors");
const fs = require("fs");
const fallbackFetch = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));
const baseFetch = typeof globalThis.fetch === "function" ? globalThis.fetch.bind(globalThis) : fallbackFetch;
const AbortControllerClass = typeof globalThis.AbortController === "function" ? globalThis.AbortController : null;
const HTTP_TIMEOUT_MS = Math.max(2000, parseInt(process.env.HTTP_TIMEOUT_MS || "", 10) || 5000);

async function fetchWithTimeout(resource, options = {}) {
  if (!AbortControllerClass) {
    return baseFetch(resource, options);
  }

  const controller = new AbortControllerClass();
  const timeoutId = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);

  try {
    return await baseFetch(resource, { ...options, signal: controller.signal });
  } catch (error) {
    if (error && error.name === "AbortError") {
      const timeoutError = new Error(`Request timed out after ${HTTP_TIMEOUT_MS}ms`);
      timeoutError.cause = error;
      timeoutError.status = 408;
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}
const bcrypt = require("bcrypt");
const { WebhookClient, EmbedBuilder } = require("discord.js");

const app = express();
const PORT = process.env.PORT || 3000;
const SUPABASE_URL =
  process.env.SUPABASE_URL ||
  process.env.NEXT_PUBLIC_SUPABASE_URL ||
  process.env.SUPABASE_PROJECT_URL;
const SUPABASE_KEY =
  process.env.SUPABASE_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SERVICE_KEY ||
  process.env.SUPABASE_ANON_KEY ||
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  throw new Error(
    "Supabase environment variables are missing. Please set SUPABASE_URL and SUPABASE_KEY (or SUPABASE_SERVICE_ROLE_KEY)."
  );
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { global: { fetch: fetchWithTimeout } });

const EVENTS_TABLE = "events";
const PLAYER_EVENT_RECORDS_TABLE = "player_event_records";
const MINECRAFT_SERVER_IP = process.env.MINECRAFT_SERVER_IP || "play.ranktiers.gg";
const DISCORD_INVITE = process.env.DISCORD_INVITE || "https://discord.gg/wQMUPyxcQj";
const MAX_SEARCH_RESULTS = 20;

// -------------------- FILE UPLOAD --------------------
const UPLOAD_DIR = process.env.UPLOAD_DIR || "uploads";
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);

const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, UPLOAD_DIR),
  filename: (_, file, cb) => cb(null, Date.now() + "-" + file.originalname.replace(/\s+/g, "-")),
});
const upload = multer({ storage });

// -------------------- EXPRESS CONFIG --------------------
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.static(path.join(__dirname, "public")));
app.use(express.urlencoded({ extended: true }));
app.use(cors());
app.use(
  session({
    secret: process.env.SESSION_SECRET || "dev_secret",
    resave: false,
    saveUninitialized: true,
  })
);

app.use((req, res, next) => {
  res.locals.currentUser = req.session.user || null;
  res.locals.currentAdmin = req.session.admin || null;
  res.locals.minecraftServerIp = MINECRAFT_SERVER_IP;
  res.locals.discordInvite = DISCORD_INVITE;
  next();
});

const TIERS = ["LT5", "HT5", "LT4", "HT4", "LT3", "HT3", "LT2", "HT2", "LT1", "HT1"];

function buildBracket(players) {
  const sanitized = players.filter(Boolean);
  if (sanitized.length === 0) return { rounds: [] };

  const bracketSize = Math.max(2, 1 << Math.ceil(Math.log2(sanitized.length)));
  const slots = [...sanitized];
  while (slots.length < bracketSize) slots.push(null);

  const rounds = [];
  let previousRound = [];

  const firstRound = [];
  for (let i = 0; i < slots.length; i += 2) {
    const matchId = `r1m${i / 2 + 1}`;
    firstRound.push({
      id: matchId,
      round: 1,
      match: i / 2 + 1,
      player1: slots[i],
      player2: slots[i + 1],
      winner: null,
      loser: null,
      autoAdvance: false,
      source1: null,
      source2: null,
      nextMatchId: null,
      nextMatchSlot: null,
    });
  }
  rounds.push(firstRound);
  previousRound = firstRound;

  let roundNumber = 2;
  while (previousRound.length > 1) {
    const currentRound = [];
    for (let i = 0; i < previousRound.length; i += 2) {
      const matchId = `r${roundNumber}m${i / 2 + 1}`;
      const match = {
        id: matchId,
        round: roundNumber,
        match: i / 2 + 1,
        player1: null,
        player2: null,
        winner: null,
        loser: null,
        autoAdvance: false,
        source1: previousRound[i]?.id || null,
        source2: previousRound[i + 1]?.id || null,
        nextMatchId: null,
        nextMatchSlot: null,
      };
      currentRound.push(match);
      if (previousRound[i]) {
        previousRound[i].nextMatchId = matchId;
        previousRound[i].nextMatchSlot = "player1";
      }
      if (previousRound[i + 1]) {
        previousRound[i + 1].nextMatchId = matchId;
        previousRound[i + 1].nextMatchSlot = "player2";
      }
    }
    rounds.push(currentRound);
    previousRound = currentRound;
    roundNumber++;
  }

  return { rounds };
}

async function fetchPlayersByIds(ids = []) {
  if (!Array.isArray(ids) || ids.length === 0) return [];

  const chunkSize = 99;
  const players = [];

  for (let index = 0; index < ids.length; index += chunkSize) {
    const chunk = ids.slice(index, index + chunkSize);
    const { data, error } = await supabase.from("players").select("id, username").in("id", chunk);
    if (error) throw new Error(`Failed to load player profiles: ${error.message}`);
    if (data) players.push(...data);
  }

  return players;
}

function indexBracketMatches(bracket) {
  const map = new Map();
  if (!bracket || !Array.isArray(bracket.rounds)) return map;
  bracket.rounds.forEach(round => {
    round.forEach(match => {
      map.set(match.id, match);
    });
  });
  return map;
}

function propagateAutoAdvances(bracket) {
  const matchMap = indexBracketMatches(bracket);
  const queue = [];
  matchMap.forEach(match => {
    const onlyOne = (match.player1 && !match.player2) || (!match.player1 && match.player2);
    if (onlyOne && !match.winner) {
      match.autoAdvance = true;
      match.winner = match.player1 || match.player2;
      queue.push(match);
    }
  });

  while (queue.length > 0) {
    const match = queue.shift();
    if (!match.nextMatchId || !match.winner) continue;
    const next = matchMap.get(match.nextMatchId);
    if (!next) continue;
    next[match.nextMatchSlot] = match.winner;
    const onlyOne = (next.player1 && !next.player2) || (!next.player1 && next.player2);
    if (onlyOne && !next.winner) {
      next.autoAdvance = true;
      next.winner = next.player1 || next.player2;
      queue.push(next);
    }
  }
}

function assignWinnerToNextMatch(bracket, match) {
  if (!match.nextMatchId || !match.winner) return;
  const matchMap = indexBracketMatches(bracket);
  const next = matchMap.get(match.nextMatchId);
  if (!next) return;
  next[match.nextMatchSlot] = match.winner;
  const onlyOne = (next.player1 && !next.player2) || (!next.player1 && next.player2);
  if (onlyOne && !next.winner) {
    next.autoAdvance = true;
    next.winner = next.player1 || next.player2;
    assignWinnerToNextMatch(bracket, next);
  }
}

function normalizeBracketObject(maybeBracket) {
  if (!maybeBracket || typeof maybeBracket !== "object") {
    return { rounds: [] };
  }

  if (!Array.isArray(maybeBracket.rounds)) {
    return { ...maybeBracket, rounds: [] };
  }

  return maybeBracket;
}

function parseBracket(rawBracket) {
  if (typeof rawBracket === "string") {
    try {
      const parsed = JSON.parse(rawBracket);
      return normalizeBracketObject(parsed);
    } catch (error) {
      console.error("Failed to parse bracket JSON", error);
      return { rounds: [] };
    }
  }

  return normalizeBracketObject(rawBracket);
}

function findMatch(bracket, matchId) {
  if (!bracket || !Array.isArray(bracket.rounds)) return null;
  for (const round of bracket.rounds) {
    for (const match of round) {
      if (match.id === matchId) return match;
    }
  }
  return null;
}

app.get("/discord", (_, res) => {
  res.redirect(DISCORD_INVITE);
});

// -------------------- DISCORD WEBHOOK --------------------
const webhook = process.env.DISCORD_WEBHOOK_URL
  ? new WebhookClient({ url: process.env.DISCORD_WEBHOOK_URL })
  : null;

async function sendDiscordTierUpdate({ username, game, kit, tier, updated }) {
  if (!webhook) return;
  try {
    const embed = new EmbedBuilder()
      .setTitle(updated ? "🔁 Tier Updated" : "🌟 New Tier Earned!")
      .setDescription(
        `**${username}** has ${updated ? "updated" : "earned"} a tier in **${game}**!\n\n🎮 **Kit:** ${kit}\n🏅 **Tier:** ${tier}`
      )
      .setColor(updated ? 0xf1c40f : 0x2ecc71)
      .setTimestamp();
    await webhook.send({ embeds: [embed] });
  } catch (err) {
    console.error("Error sending Discord webhook:", err);
  }
}

// -------------------- UTILITY FUNCTIONS --------------------
async function getMinecraftUUID(username) {
  try {
    const res = await fetchWithTimeout(`https://api.mojang.com/users/profiles/minecraft/${username}`);
    if (!res.ok) return null;
    const data = await res.json();
    return data.id;
  } catch (err) {
    console.error("Error fetching Minecraft UUID:", err);
    return null;
  }
}

function buildMinecraftRenderUrl(uuid, username) {
  if (uuid) {
    const normalized = uuid.replace(/-/g, "");
    return `https://crafatar.com/renders/body/${normalized}?size=256&overlay`;
  }
  if (username) {
    return `https://minotar.net/armor/body/${encodeURIComponent(username)}/256.png`;
  }
  return null;
}

const KIT_TEXTURE_BASE =
  "https://raw.githubusercontent.com/InventivetalentDev/minecraft-assets/1.21.10/assets/minecraft/textures";
const KIT_TEXTURE_FALLBACK = `${KIT_TEXTURE_BASE}/item/netherite_sword.png`;

const kitTextureRules = [
  { match: /(archer|bow|ranger|sniper)/i, path: "item/bow.png" },
  { match: /(tank|guardian|heavy|knight)/i, path: "item/netherite_chestplate.png" },
  { match: /(mage|wizard|spell|sorcerer)/i, path: "item/blaze_powder.png" },
  { match: /(healer|support|medic|paladin)/i, path: "item/golden_apple.png" },
  { match: /(rogue|assassin|ninja)/i, path: "item/iron_sword.png" },
  { match: /(axe)/i, path: "item/diamond_axe.png" },
  { match: /(shield)/i, path: "item/shield.png" },
  { match: /(pickaxe|miner|builder|bridge)/i, path: "item/diamond_pickaxe.png" },
  { match: /(rod)/i, path: "item/fishing_rod.png" },
  { match: /(uhc|survivalist)/i, path: "item/golden_apple.png" },
  { match: /(sumo)/i, path: "item/slime_ball.png" },
  { match: /(crystal)/i, path: "item/end_crystal.png" },
  { match: /(pearl|ender)/i, path: "item/ender_pearl.png" },
  { match: /(sky|elytra|flight)/i, path: "item/elytra.png" },
  { match: /(bedwars|bed defender|bed)/i, path: "item/red_bed.png" },
  { match: /(pot|potion)/i, path: "item/potion_bottle_splash.png" },
  { match: /(combo|duel|pvp|sword|classic)/i, path: "item/diamond_sword.png" },
];

function normalizeKitKey(name = "") {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function resolveKitTexturePath(kitName = "") {
  const normalized = typeof kitName === "string" ? kitName.trim() : "";
  if (!normalized) return "item/netherite_sword.png";
  const kitKey = normalizeKitKey(normalized);
  if (kitKey) {
    if (kitKey.includes("mace")) return "item/mace.png";
    if (kitKey.includes("lifesteal")) return "gui/sprites/hud/heart/full.png";
    if (kitKey === "smp" || kitKey.includes("survivalmultiplayer")) return "item/shield.png";
    if (kitKey.includes("neth") && kitKey.includes("pot")) return "item/potion_bottle_splash.png";
    if (kitKey.includes("spear")) return "item/spear.png";
  }
  for (const rule of kitTextureRules) {
    if (rule.match.test(normalized)) return rule.path;
  }
  return "item/netherite_sword.png";
}

function resolveKitTextureUrl(kitName = "") {
  try {
    const path = resolveKitTexturePath(kitName);
    return `${KIT_TEXTURE_BASE}/${path}`;
  } catch (err) {
    console.error("Error resolving kit texture", kitName, err);
    return KIT_TEXTURE_FALLBACK;
  }
}

function buildKitTextureMap(names = []) {
  return names.reduce((acc, name) => {
    if (!name || acc[name]) return acc;
    acc[name] = resolveKitTextureUrl(name);
    return acc;
  }, {});
}

function requireAuth(req, res, next) {
  if (!req.session.user) return res.redirect("/login");
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.admin) return res.redirect("/admin/login");
  next();
}

// -------------------- ACHIEVEMENTS --------------------
async function checkAndAwardAchievements(playerId, totalPoints, tier) {
  const { data: achievements } = await supabase.from("achievements").select("*");
  if (!achievements) return;

  for (const ach of achievements) {
    let qualifies = false;
    if (ach.condition_type === "points" && totalPoints >= ach.condition_value) qualifies = true;
    if (ach.condition_type === "tier" && tier === ach.condition_value) qualifies = true;

    if (qualifies) {
      const { data: existing } = await supabase
        .from("player_achievements")
        .select("*")
        .eq("player_id", playerId)
        .eq("achievement_id", ach.id)
        .maybeSingle();

      if (!existing)
        await supabase.from("player_achievements").insert([{ player_id: playerId, achievement_id: ach.id }]);
    }
  }
}

// -------------------- AUTH --------------------
app.get("/register", (_, res) => res.render("register", { error: null, pageTitle: "Create Account", navActive: null }));
app.post("/register", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)
    return res.render("register", { error: "Email and password required", pageTitle: "Create Account", navActive: null });

  const { data: existing } = await supabase.from("users").select("*").eq("email", email).single();
  if (existing)
    return res.render("register", { error: "Email already registered", pageTitle: "Create Account", navActive: null });

  const password_hash = await bcrypt.hash(password, 10);
  await supabase.from("users").insert([{ email, password_hash }]);
  res.redirect("/login");
});

app.get("/login", (_, res) => res.render("login", { error: null, pageTitle: "Login", navActive: null }));
app.post("/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)
    return res.render("login", { error: "Email and password required", pageTitle: "Login", navActive: null });

  const { data: user } = await supabase.from("users").select("*").eq("email", email).single();
  if (!user)
    return res.render("login", { error: "Invalid credentials", pageTitle: "Login", navActive: null });

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid)
    return res.render("login", { error: "Invalid credentials", pageTitle: "Login", navActive: null });

  req.session.user = { id: user.id, email: user.email };
  res.redirect("/account");
});

app.get("/logout", (req, res) => req.session.destroy(() => res.redirect("/")));

// -------------------- ACCOUNT LINKING --------------------
app.get("/account", requireAuth, async (req, res) => {
  const { data: linked } = await supabase
    .from("user_linked_accounts")
    .select("*")
    .eq("user_id", req.session.user.id);

  const { data: games } = await supabase.from("games").select("*").order("name");
  const minecraftOnly = (games || []).filter(game => game.name?.toLowerCase() === "minecraft");
  const availableGames = minecraftOnly.length > 0 ? minecraftOnly : [{ name: "Minecraft" }];

  res.render("account", {
    linked: linked || [],
    games: availableGames,
    error: null,
    pageTitle: "Account",
    navActive: null,
  });
});

app.post("/account/link", requireAuth, async (req, res) => {
  const { game, game_username } = req.body;
  if (!game || !game_username) return res.redirect("/account");

  if (game !== "Minecraft") {
    return res.redirect("/account");
  }

  const { data: existing } = await supabase
    .from("user_linked_accounts")
    .select("*")
    .eq("user_id", req.session.user.id)
    .eq("game", game)
    .single();

  if (existing)
    await supabase
      .from("user_linked_accounts")
      .update({ game_username, game_id: null })
      .eq("id", existing.id);
  else
    await supabase.from("user_linked_accounts").insert([
      {
        user_id: req.session.user.id,
        game,
        game_username,
        game_id: null,
      },
    ]);

  res.redirect("/account");
});

// -------------------- ADMIN --------------------
app.get("/admin/login", (_, res) => res.render("admin-login", { error: null, pageTitle: "Admin Login", navActive: null }));
app.post("/admin/login", (req, res) => {
  const { username, password } = req.body;
  if (username === process.env.ADMIN_USER && password === process.env.ADMIN_PASS) {
    req.session.admin = { username };
    return res.redirect("/admin/dashboard");
  }
  res.render("admin-login", { error: "Invalid credentials", pageTitle: "Admin Login", navActive: null });
});
app.get("/admin/logout", (req, res) => {
  req.session.admin = null;
  res.redirect("/admin/login");
});

app.get("/admin/overview", requireAdmin, async (req, res) => { // <-- CHANGED from /admin/dashboard
  const { data: games } = await supabase.from("games").select("*");
  const { data: players } = await supabase.from("players").select("*");
  const { data: submissions } = await supabase.from("submissions").select("*").order("created_at", { ascending: true });
  const minecraftGames = (games || []).filter(game => game.name?.toLowerCase() === "minecraft");
  res.render("admin-dashboard", {
    games: minecraftGames.length > 0 ? minecraftGames : games || [],
    players,
    submissions,
    stats: [],
    TIERS,
    pageTitle: "Admin Dashboard",
    navActive: null,
  }); // <-- ADDED stats: [], TIERS
});

app.post("/admin/game/add", requireAdmin, async (req, res) => {
  const { name } = req.body;
  if (!name) return res.redirect("/admin/dashboard");
  await supabase.from("games").insert([{ name }]);
  res.redirect("/admin/dashboard");
});

// -------------------- MAIN PAGES --------------------
app.get("/", async (req, res) => {
  let games = [];
  try {
    const { data, error } = await supabase.from("games").select("*").order("name");
    if (error) throw error;
    games = data || [];
  } catch (error) {
    console.error("Failed to load games", error);
  }

  let linkedAccounts = [];
  if (req.session.user) {
    try {
      const { data, error } = await supabase
        .from("user_linked_accounts")
        .select("*")
        .eq("user_id", req.session.user.id)
        .eq("game", "Minecraft");
      if (error) throw error;
      linkedAccounts = data || [];
    } catch (error) {
      console.error("Failed to load linked accounts", error);
    }
  }

  const minecraftOnly = (games || []).filter(game => game.name?.toLowerCase() === "minecraft");
  const featuredGames = minecraftOnly.length > 0 ? minecraftOnly : [{ name: "Minecraft" }];

  let upcomingEvent = null;
  let upcomingEventTextures = {};
  let spotlightPlayers = [];
  let spotlightKitTextures = {};
  try {
    const { data, error } = await supabase
      .from(EVENTS_TABLE)
      .select("id, name, kit, created_at")
      .eq("game", "Minecraft")
      .order("created_at", { ascending: false })
      .limit(1);
    if (error) throw error;
    if (data && data.length > 0) {
      upcomingEvent = data[0];
      upcomingEventTextures = buildKitTextureMap([upcomingEvent.kit]);
    }
  } catch (error) {
    console.error("Failed to load featured event", error);
  }

  try {
    const { data, error } = await supabase
      .from("player_stats")
      .select("player_id, kit, points, players(username, minecraft_uuid, minecraft_username)")
      .eq("game", "Minecraft");

    if (error) throw error;

    const aggregated = new Map();
    (data || []).forEach(row => {
      if (!row || !row.player_id) return;
      if (!aggregated.has(row.player_id)) {
        aggregated.set(row.player_id, {
          playerId: row.player_id,
          player: row.players || {},
          totalPoints: 0,
          kits: new Set(),
        });
      }
      const entry = aggregated.get(row.player_id);
      entry.totalPoints += row.points || 0;
      if (row.kit) entry.kits.add(row.kit);
    });

    const sorted = Array.from(aggregated.values())
      .map(entry => ({
        ...entry,
        kits: Array.from(entry.kits),
      }))
      .sort((a, b) => b.totalPoints - a.totalPoints)
      .slice(0, 3);

    const withUsernames = sorted.filter(entry => entry.player?.username);

    const kitNames = new Set();
    spotlightPlayers = withUsernames.map(entry => {
      const username = entry.player.username;
      const lookupName = entry.player?.minecraft_username || username;
      const renderUrl = buildMinecraftRenderUrl(entry.player?.minecraft_uuid, lookupName);
      entry.kits.forEach(kit => {
        if (kit) kitNames.add(kit);
      });

      return {
        username,
        totalPoints: entry.totalPoints,
        kits: entry.kits,
        renderUrl,
        profileUrl: `/profile/${encodeURIComponent(username)}`,
      };
    });

    spotlightKitTextures = buildKitTextureMap([...kitNames]);
  } catch (error) {
    console.error("Failed to load spotlight players", error);
  }

  res.render("index", {
    games: featuredGames,
    linkedAccounts,
    upcomingEvent,
    upcomingEventTextures,
    spotlightPlayers,
    spotlightKitTextures,
    pageTitle: "Home",
    navActive: "home",
  });
});

app.get("/search", async (req, res) => {
  const query = (req.query.q || "").trim();
  let results = [];
  let searchError = null;
  let kitTextures = {};

  if (query) {
    try {
      const { data: playersData, error: playersError } = await supabase
        .from("players")
        .select("id, username, minecraft_uuid, minecraft_username")
        .ilike("username", `%${query}%`)
        .order("username")
        .limit(MAX_SEARCH_RESULTS);

      if (playersError) throw playersError;

      const playerIds = (playersData || []).map(player => player.id).filter(Boolean);
      const statsMap = new Map();

      if (playerIds.length > 0) {
        const { data: statsData, error: statsError } = await supabase
          .from("player_stats")
          .select("player_id, kit, tier, points")
          .in("player_id", playerIds)
          .eq("game", "Minecraft");

        if (statsError) throw statsError;

        (statsData || []).forEach(stat => {
          if (!statsMap.has(stat.player_id)) {
            statsMap.set(stat.player_id, {
              totalPoints: 0,
              kits: [],
              bestTier: null,
            });
          }
          const entry = statsMap.get(stat.player_id);
          entry.totalPoints += stat.points || 0;
          if (stat.kit) {
            entry.kits.push({ kit: stat.kit, tier: stat.tier });
          }
          if (stat.tier) {
            const currentIndex = TIERS.indexOf(entry.bestTier);
            const tierIndex = TIERS.indexOf(stat.tier);
            if (tierIndex !== -1 && (currentIndex === -1 || tierIndex < currentIndex)) {
              entry.bestTier = stat.tier;
            }
          }
        });
      }

      const kitNames = new Set();
      results = (playersData || []).map(player => {
        const stats = statsMap.get(player.id) || { totalPoints: 0, kits: [], bestTier: null };
        stats.kits.forEach(kit => {
          if (kit?.kit) kitNames.add(kit.kit);
        });
        const lookupName = player.minecraft_username || player.username;
        return {
          username: player.username,
          profileUrl: `/profile/${encodeURIComponent(player.username)}`,
          renderUrl: buildMinecraftRenderUrl(player.minecraft_uuid, lookupName),
          totalPoints: stats.totalPoints,
          bestTier: stats.bestTier,
          kits: stats.kits,
        };
      });

      kitTextures = buildKitTextureMap([...kitNames]);
    } catch (error) {
      console.error("Failed to search players", error);
      searchError = "We couldn't load search results right now. Please try again later.";
    }
  }

  res.render("search", {
    query,
    results,
    searchError,
    kitTextures,
    pageTitle: "Search Players",
    navActive: "search",
    maxResults: MAX_SEARCH_RESULTS,
  });
});

app.get("/terms", (req, res) => {
  res.render("terms", { pageTitle: "Terms of Service", navActive: null });
});

app.get("/privacy", (req, res) => {
  res.render("privacy", { pageTitle: "Privacy Policy", navActive: null });
});

app.get("/events", async (req, res) => {
  let events = [];
  let eventsError = null;
  const kitFilter = (req.query.kit || "").trim();
  let availableKits = [];

  try {
    const { data, error } = await supabase
      .from(EVENTS_TABLE)
      .select("id, name, game, kit, created_at")
      .order("created_at", { ascending: false });

    if (error) throw error;
    const allEvents = data || [];
    availableKits = Array.from(
      new Set(allEvents.map(event => event.kit).filter(Boolean))
    ).sort((a, b) => a.localeCompare(b));
    events = kitFilter ? allEvents.filter(event => event.kit === kitFilter) : allEvents;
  } catch (error) {
    console.error("Failed to load events", error);
    eventsError = "Unable to load events right now. Please try again later.";
  }

  const kitTextures = buildKitTextureMap(
    (availableKits.length > 0 ? availableKits : (events || []).map(event => event.kit)).filter(Boolean)
  );

  res.render("events", {
    events,
    eventsError,
    kitTextures,
    kitFilter,
    availableKits,
    pageTitle: "Events",
    navActive: "events",
  });
});

app.get("/events/:id", async (req, res) => {
  const eventId = req.params.id;
  let event;

  try {
    const { data, error } = await supabase
      .from(EVENTS_TABLE)
      .select("*")
      .eq("id", eventId)
      .maybeSingle();
    if (error) throw error;
    event = data;
  } catch (error) {
    console.error("Failed to fetch event", error);
    const statusCode = error?.status === 408 ? 504 : 500;
    return res.status(statusCode).send(statusCode === 504 ? "Event data request timed out." : "Unable to load event.");
  }

  if (!event) return res.status(404).send("Event not found");

  const bracket = parseBracket(event.bracket);
  let eventRecords = [];
  let viewError = null;

  try {
    const { data, error } = await supabase
      .from(PLAYER_EVENT_RECORDS_TABLE)
      .select("player_id, wins, losses, players(username)")
      .eq("event_id", eventId);

    if (error) throw error;
    if (data) eventRecords = data;
  } catch (recordsError) {
    console.error("Failed to fetch event records", recordsError);
    viewError = recordsError?.status === 408
      ? "Participant data timed out. Please refresh to try again."
      : "Participant records are temporarily unavailable.";
  }

  res.render("event", {
    event,
    bracket,
    adminView: false,
    records: eventRecords,
    adminMessage: null,
    adminError: null,
    eventError: viewError,
    admin: req.session.admin || null,
    pageTitle: event.name,
    navActive: "events",
    kitTexture: event.kit ? resolveKitTextureUrl(event.kit) : null,
  });
});

app.get("/game/:name", async (req, res) => {
  const { name } = req.params;
  const { data: allStats } = await supabase
    .from("player_stats")
    .select("player_id, kit, tier, points, players(username)")
    .eq("game", name);

  if (!allStats || allStats.length === 0)
    return res.render("game", {
      stats: [],
      gameName: name,
      userLinked: [],
      kitTextures: {},
      pageTitle: `${name} Leaderboard`,
      navActive: "leaderboard",
    });

  const map = {};
  allStats.forEach(stat => {
    const pid = stat.player_id;
    if (!map[pid]) map[pid] = { players: stat.players, total_points: 0, kits: [] };
    map[pid].total_points += stat.points;
    map[pid].kits.push({ kit: stat.kit, tier: stat.tier });
  });
  const stats = Object.values(map).sort((a, b) => b.total_points - a.total_points);

  const kitNames = new Set();
  stats.forEach(entry => {
    (entry.kits || []).forEach(kit => {
      if (kit?.kit) kitNames.add(kit.kit);
    });
  });

  let userLinked = [];
  if (req.session.user) {
    const { data } = await supabase
      .from("user_linked_accounts")
      .select("*")
      .eq("user_id", req.session.user.id)
      .eq("game", name);
    userLinked = data || [];
  }

  res.render("game", {
    stats,
    gameName: name,
    userLinked,
    kitTextures: buildKitTextureMap([...kitNames]),
    pageTitle: `${name} Leaderboard`,
    navActive: "leaderboard",
  });
});

// -------------------- PROFILE --------------------
app.get("/profile/:username", async (req, res) => {
  const { username } = req.params;
  const { data: player } = await supabase.from("players").select("*").eq("username", username).single();
  if (!player) return res.status(404).send("Player not found");

  const { data: stats } = await supabase
    .from("player_stats")
    .select("game, kit, tier, points")
    .eq("player_id", player.id)
    .order("points", { ascending: false });

  const { data: achievements } = await supabase
    .from("player_achievements")
    .select("earned_at, achievements(name, description, icon)")
    .eq("player_id", player.id);

  const { data: eventRecords } = await supabase
    .from(PLAYER_EVENT_RECORDS_TABLE)
    .select("event_id, wins, losses, events(name, game, kit)")
    .eq("player_id", player.id);

  const hasMinecraft = (stats || []).some(s => s.game.toLowerCase() === "minecraft");
  const minecraftLookupName = player.minecraft_username || username;
  let mcRenderUrl = null;
  if (hasMinecraft) {
    if (player.minecraft_uuid) {
      mcRenderUrl = buildMinecraftRenderUrl(player.minecraft_uuid, minecraftLookupName);
    } else {
      const resolvedUUID = await getMinecraftUUID(minecraftLookupName);
      mcRenderUrl = buildMinecraftRenderUrl(resolvedUUID, minecraftLookupName);
    }
  }

  const kitNames = new Set((stats || []).map(stat => stat.kit).filter(Boolean));
  (eventRecords || []).forEach(record => {
    const kit = record?.events?.kit;
    if (kit) kitNames.add(kit);
  });

  const totalPoints = (stats || []).reduce((a, s) => a + s.points, 0);
  res.render("profile", {
    player,
    stats: stats || [],
    achievements: achievements || [],
    mcRenderUrl,
    totalPoints,
    eventRecords: eventRecords || [],
    kitTextures: buildKitTextureMap([...kitNames]),
    pageTitle: `${player.username} | Profile`,
    navActive: null,
  });
});

// -------------------- ADVANCED ADMIN MANAGEMENT --------------------

// Add a new player manually
app.post("/admin/player/add", requireAdmin, async (req, res) => {
  const { username } = req.body;
  if (!username) return res.redirect("/admin/dashboard");
  await supabase.from("players").insert([{ username }]);
  res.redirect("/admin/dashboard");
});

// Edit a player's tier or points (and trigger Discord notification)
app.post("/admin/stat/update/:id", requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { tier, points } = req.body;

  const { data: stat } = await supabase
    .from("player_stats")
    .select("id, player_id, kit, tier, points, game, players(username)")
    .eq("id", id)
    .single();

  if (!stat) return res.redirect("/admin/dashboard");

  const updatedTier = tier || stat.tier;
  const updatedPoints = parseInt(points) || stat.points;

  await supabase
    .from("player_stats")
    .update({ tier: updatedTier, points: updatedPoints })
    .eq("id", id);

  // ✅ Send webhook notification
  await sendDiscordTierUpdate({
    username: stat.players.username,
    game: stat.game,
    kit: stat.kit,
    tier: updatedTier,
    updated: true,
  });

  res.redirect("/admin/dashboard");
});

// Delete record (player, game, or stat)
app.post("/admin/delete/:table/:id", requireAdmin, async (req, res) => {
  const { table, id } = req.params;
  const validTables = ["games", "players", "player_stats"];
  if (!validTables.includes(table)) return res.redirect("/admin/dashboard");
  await supabase.from(table).delete().eq("id", id);
  res.redirect("/admin/dashboard");
});

app.post("/admin/events/create", requireAdmin, async (req, res) => {
  const { name, game, kit, tiers_all, tiers } = req.body;
  if (!name || !game || !kit) {
    req.session.adminError = "Event name, game, and kit are required.";
    return res.redirect("/admin/dashboard");
  }

  let selectedTiers = [];
  if (tiers_all === "on") selectedTiers = [...TIERS];
  else if (Array.isArray(tiers)) selectedTiers = tiers;
  else if (typeof tiers === "string" && tiers.trim() !== "") selectedTiers = [tiers];

  if (selectedTiers.length === 0) selectedTiers = [...TIERS];

  try {
    let query = supabase
      .from("player_stats")
      .select("player_id, tier")
      .eq("game", game)
      .eq("kit", kit);

    if (selectedTiers.length !== TIERS.length) {
      query = query.in("tier", selectedTiers);
    }

    const { data: stats, error: statsError } = await query;
    if (statsError) throw new Error(`Failed to load eligible players: ${statsError.message}`);

    if (!stats || stats.length === 0) {
      req.session.adminError = "No players found for the selected criteria.";
      return res.redirect("/admin/dashboard");
    }

    const seen = new Set();
    const uniquePlayerIds = [];
    stats.forEach(stat => {
      if (stat.player_id && !seen.has(stat.player_id)) {
        seen.add(stat.player_id);
        uniquePlayerIds.push(stat.player_id);
      }
    });

    if (uniquePlayerIds.length === 0) {
      req.session.adminError = "No eligible players were found for this event.";
      return res.redirect("/admin/dashboard");
    }

    const playersLookup = await fetchPlayersByIds(uniquePlayerIds);

    const usernameMap = new Map();
    (playersLookup || []).forEach(player => {
      if (player?.id) {
        usernameMap.set(player.id, player.username || `Player ${player.id}`);
      }
    });

    const participants = uniquePlayerIds.map(id => ({
      id,
      username: usernameMap.get(id) || `Player ${id}`,
    }));

    participants.sort(() => Math.random() - 0.5);

    if (participants.length < 2) {
      req.session.adminError = "At least two players are required to create an event.";
      return res.redirect("/admin/dashboard");
    }

    const bracket = buildBracket(participants);
    propagateAutoAdvances(bracket);

    const { data: createdEvent, error: eventError } = await supabase
      .from(EVENTS_TABLE)
      .insert([
        {
          name,
          game,
          kit,
          tiers: selectedTiers,
          bracket,
        },
      ])
      .select()
      .single();

    if (eventError) throw eventError;

    const { error: recordsError } = await supabase
      .from(PLAYER_EVENT_RECORDS_TABLE)
      .upsert(
        participants.map(participant => ({
          event_id: createdEvent.id,
          player_id: participant.id,
          wins: 0,
          losses: 0,
        })),
        { onConflict: "event_id,player_id" }
      );

    if (recordsError) throw new Error(`Failed to initialize event records: ${recordsError.message}`);

    req.session.adminMessage = `Event "${name}" created successfully.`;
    return res.redirect(`/admin/events/${createdEvent.id}`);
  } catch (error) {
    console.error("Failed to create event", error);
    req.session.adminError = error?.message ? `Failed to create event: ${error.message}` : "Failed to create event. Please try again.";
    return res.redirect("/admin/dashboard");
  }
});

app.get("/admin/events/:id", requireAdmin, async (req, res) => {
  const eventId = req.params.id;
  const { data: event, error } = await supabase
    .from(EVENTS_TABLE)
    .select("*")
    .eq("id", eventId)
    .single();
  if (error || !event) {
    req.session.adminError = "Event not found.";
    return res.redirect("/admin/dashboard");
  }

  const bracket = parseBracket(event.bracket);
  let eventError = null;

  const { data: records, error: recordsError } = await supabase
    .from(PLAYER_EVENT_RECORDS_TABLE)
    .select("player_id, wins, losses, players(username)")
    .eq("event_id", eventId);

  let eventRecords = [];
  if (recordsError) {
    console.error("Failed to load event records", recordsError);
    eventError = "Participant records are temporarily unavailable.";
  } else if (records) {
    eventRecords = records;
  }

  const adminMessage = req.session.adminMessage || null;
  const adminError = req.session.adminError || null;
  req.session.adminMessage = null;
  req.session.adminError = null;

  res.render("event", {
    event,
    bracket,
    adminView: true,
    records: eventRecords,
    adminMessage,
    adminError,
    eventError,
    admin: req.session.admin || null,
    pageTitle: `${event.name} | Admin View`,
    navActive: "events",
    kitTexture: event.kit ? resolveKitTextureUrl(event.kit) : null,
  });
});

app.post("/admin/events/:id/report", requireAdmin, async (req, res) => {
  const eventId = req.params.id;
  const { matchId, winnerId } = req.body;

  if (!matchId || !winnerId) {
    req.session.adminError = "Match and winner are required.";
    return res.redirect(`/admin/events/${eventId}`);
  }

  try {
    const { data: event, error: eventError } = await supabase
      .from(EVENTS_TABLE)
      .select("*")
      .eq("id", eventId)
      .single();
    if (eventError || !event) {
      req.session.adminError = "Event not found.";
      return res.redirect("/admin/dashboard");
    }

    const bracket = parseBracket(event.bracket);
    const match = findMatch(bracket, matchId);

    if (!match) {
      req.session.adminError = "Match not found in bracket.";
      return res.redirect(`/admin/events/${eventId}`);
    }
    if (match.autoAdvance) {
      req.session.adminError = "Auto-advanced matches cannot be overridden.";
      return res.redirect(`/admin/events/${eventId}`);
    }
    if (!match.player1 || !match.player2) {
      req.session.adminError = "Both players must be set before recording a result.";
      return res.redirect(`/admin/events/${eventId}`);
    }
    if (match.winner) {
      req.session.adminError = "This match result has already been recorded.";
      return res.redirect(`/admin/events/${eventId}`);
    }

    let winnerPlayer = null;
    let loserPlayer = null;
    if (String(match.player1.id) === String(winnerId)) {
      winnerPlayer = match.player1;
      loserPlayer = match.player2;
    } else if (String(match.player2.id) === String(winnerId)) {
      winnerPlayer = match.player2;
      loserPlayer = match.player1;
    } else {
      req.session.adminError = "Winner must be one of the match participants.";
      return res.redirect(`/admin/events/${eventId}`);
    }

    match.winner = winnerPlayer;
    match.loser = loserPlayer;
    match.completedAt = new Date().toISOString();
    assignWinnerToNextMatch(bracket, match);

    const { error: updateError } = await supabase
      .from(EVENTS_TABLE)
      .update({ bracket })
      .eq("id", eventId);
    if (updateError) throw updateError;

    const { data: winnerRecord } = await supabase
      .from(PLAYER_EVENT_RECORDS_TABLE)
      .select("wins, losses")
      .eq("event_id", event.id)
      .eq("player_id", winnerPlayer.id)
      .maybeSingle();

    await supabase.from(PLAYER_EVENT_RECORDS_TABLE).upsert(
      [
        {
          event_id: event.id,
          player_id: winnerPlayer.id,
          wins: (winnerRecord?.wins || 0) + 1,
          losses: winnerRecord?.losses || 0,
        },
      ],
      { onConflict: "event_id,player_id" }
    );

    if (loserPlayer) {
      const { data: loserRecord } = await supabase
        .from(PLAYER_EVENT_RECORDS_TABLE)
        .select("wins, losses")
        .eq("event_id", event.id)
        .eq("player_id", loserPlayer.id)
        .maybeSingle();

      await supabase.from(PLAYER_EVENT_RECORDS_TABLE).upsert(
        [
          {
            event_id: event.id,
            player_id: loserPlayer.id,
            wins: loserRecord?.wins || 0,
            losses: (loserRecord?.losses || 0) + 1,
          },
        ],
        { onConflict: "event_id,player_id" }
      );
    }

    req.session.adminMessage = "Match result recorded.";
    res.redirect(`/admin/events/${eventId}`);
  } catch (error) {
    console.error("Failed to record match", error);
    req.session.adminError = "Failed to record match result.";
    res.redirect(`/admin/events/${eventId}`);
  }
});

// Enhanced Admin Dashboard with management tables
app.get("/admin/dashboard", requireAdmin, async (req, res) => {
  const { data: games } = await supabase.from("games").select("*").order("name");
  const { data: players } = await supabase.from("players").select("*").order("username");
  const { data: stats } = await supabase
    .from("player_stats")
    .select("id, player_id, game, kit, tier, points, players(username)")
    .order("points", { ascending: false });
  const { data: events } = await supabase
    .from(EVENTS_TABLE)
    .select("id, name, game, kit, created_at")
    .order("created_at", { ascending: false });

  const adminMessage = req.session.adminMessage || null;
  const adminError = req.session.adminError || null;
  req.session.adminMessage = null;
  req.session.adminError = null;

  res.render("admin-dashboard", {
    admin: req.session.admin,
    games: (() => {
      const minecraftGames = (games || []).filter(game => game.name?.toLowerCase() === "minecraft");
      return minecraftGames.length > 0 ? minecraftGames : games || [];
    })(),
    players: players || [],
    stats: stats || [],
    events: events || [],
    TIERS,
    adminMessage,
    adminError,
    pageTitle: "Admin Dashboard",
    navActive: null,
  });
});


// -------------------- COMPARE --------------------
app.get("/compare", async (req, res) => {
  const { player1, player2 } = req.query;
  if (!player1 || !player2)
    return res.render("compare", { error: "Please enter both players.", pageTitle: "Compare Players", navActive: null });

  const { data: p1 } = await supabase.from("players").select("*").eq("username", player1).single();
  const { data: p2 } = await supabase.from("players").select("*").eq("username", player2).single();
  if (!p1 || !p2)
    return res.render("compare", { error: "Player not found.", pageTitle: "Compare Players", navActive: null });

  const { data: s1 } = await supabase.from("player_stats").select("*").eq("player_id", p1.id);
  const { data: s2 } = await supabase.from("player_stats").select("*").eq("player_id", p2.id);

  const total1 = s1.reduce((a, s) => a + s.points, 0);
  const total2 = s2.reduce((a, s) => a + s.points, 0);

  const totalGames1 = s1.length;
  const totalGames2 = s2.length;

  const avg1 = totalGames1 > 0 ? (total1 / totalGames1).toFixed(1) : 0;
  const avg2 = totalGames2 > 0 ? (total2 / totalGames2).toFixed(1) : 0;

  const winRate1 = (total1 + total2) > 0 ? ((total1 / (total1 + total2)) * 100).toFixed(1) : 0;
  const winRate2 = (total1 + total2) > 0 ? ((total2 / (total1 + total2)) * 100).toFixed(1) : 0;

  const kits1 = [...new Set(s1.map(s => `${s.kit} (${s.tier})`))];
  const kits2 = [...new Set(s2.map(s => `${s.kit} (${s.tier})`))];

  res.render("compare", {
    player1: p1,
    player2: p2,
    total1,
    total2,
    totalGames1,
    totalGames2,
    avg1,
    avg2,
    winRate1,
    winRate2,
    kits1,
    kits2,
    error: null,
    pageTitle: "Compare Players",
    navActive: null,
  });
});

// -------------------- SUBMIT --------------------
app.get("/submit", (_, res) =>
  res.render("submit", { error: null, success: null, pageTitle: "Submit Proof", navActive: "submit" })
);

app.post("/submit", upload.single("screenshot"), async (req, res) => {
  try {
    const { player_name, game, kit, tier, points } = req.body;
    const screenshot = req.file ? req.file.filename : null;

    if (!TIERS.includes(tier)) {
      return res.render("submit", {
        error: "Invalid tier selected",
        success: null,
        pageTitle: "Submit Proof",
        navActive: "submit",
      });
    }

    let { data: player } = await supabase
      .from("players")
      .select("*")
      .eq("username", player_name)
      .limit(1);

    if (!player || player.length === 0) {
      const { data: created } = await supabase
        .from("players")
        .insert([{ username: player_name }])
        .select()
        .single();
      player = created;
    } else {
      player = player[0];
    }

    const { data: existing } = await supabase
      .from("player_stats")
      .select("*")
      .eq("player_id", player.id)
      .eq("game", game)
      .eq("kit", kit)
      .maybeSingle();

    let updated = false;
    if (existing) {
      await supabase
        .from("player_stats")
        .update({ tier, points: parseInt(points) || existing.points })
        .eq("id", existing.id);
      updated = true;
    } else {
      await supabase.from("player_stats").insert([
        {
          player_id: player.id,
          game,
          kit,
          tier,
          points: parseInt(points) || 0,
        },
      ]);
    }

    await supabase.from("submissions").insert([
      {
        player_id: player.id,
        player_name,
        game,
        kit,
        tier,
        points: parseInt(points) || 0,
        screenshot,
      },
    ]);

    await checkAndAwardAchievements(player.id, parseInt(points) || 0, tier);

    // ✅ Send Discord notification
    await sendDiscordTierUpdate({
      username: player.username,
      game,
      kit,
      tier,
      updated,
    });

    res.render("submit", {
      success: updated
        ? "Tier updated successfully and notification sent!"
        : "Submission received. Awaiting admin review.",
      error: null,
      pageTitle: "Submit Proof",
      navActive: "submit",
    });
  } catch (err) {
    console.error(err);
    res.render("submit", {
      error: "Submission failed.",
      success: null,
      pageTitle: "Submit Proof",
      navActive: "submit",
    });
  }
});

// -------------------- START SERVER --------------------
app.listen(PORT, () => console.log(`🚀 RankTiers running at http://localhost:${PORT}`));
