import {
  pgTable,
  serial,
  text,
  integer,
  boolean,
  timestamp,
  numeric,
  jsonb,
} from "drizzle-orm/pg-core";

// ── Users ─────────────────────────────────────────────────────────────────────
export const users = pgTable("users", {
  id:           serial("id").primaryKey(),
  username:     text("username").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  role:         text("role").notNull().default("user"),
  credits:      integer("credits").notNull().default(0),
  status:       text("status").notNull().default("active"),
  isDeleted:    boolean("is_deleted").notNull().default(false),
  createdAt:    timestamp("created_at").notNull().defaultNow(),
  updatedAt:    timestamp("updated_at").notNull().defaultNow(),
});

// ── Inventory Items ───────────────────────────────────────────────────────────
export const inventoryItems = pgTable("inventory_items", {
  id:          serial("id").primaryKey(),
  userId:      integer("user_id").references(() => users.id),
  name:        text("name").notNull(),
  category:    text("category").notNull().default("other"),
  quantity:    text("quantity").notNull().default("0"),
  unit:        text("unit"),
  status:      text("status").notNull().default("available"),
  notes:       text("notes"),
  price:       numeric("price", { precision: 10, scale: 2 }).default("0"),
  imageData:   text("image_data"),
  itemType:    text("item_type"),
  size:        text("size"),
  spacing:     text("spacing"),
  createdAt:   timestamp("created_at").notNull().defaultNow(),
  updatedAt:   timestamp("updated_at").notNull().defaultNow(),
});

// ── Projects ──────────────────────────────────────────────────────────────────
export const projects = pgTable("projects", {
  id:              serial("id").primaryKey(),
  userId:          integer("user_id").notNull().references(() => users.id),
  clientName:      text("client_name").notNull(),
  clientPhone:     text("client_phone"),
  clientAddress:   text("client_address"),
  gardenImageData: text("garden_image_data"),
  designData:      text("design_data"),
  totalEstimate:   numeric("total_estimate", { precision: 12, scale: 2 }).default("0"),
  createdAt:       timestamp("created_at").notNull().defaultNow(),
  updatedAt:       timestamp("updated_at").notNull().defaultNow(),
});

// ── Usage Logs ────────────────────────────────────────────────────────────────
export const usageLogs = pgTable("usage_logs", {
  id:          serial("id").primaryKey(),
  userId:      integer("user_id").notNull().references(() => users.id),
  action:      text("action").notNull(),
  creditsUsed: integer("credits_used").notNull().default(1),
  createdAt:   timestamp("created_at").notNull().defaultNow(),
});

// ── Payments ──────────────────────────────────────────────────────────────────
export const payments = pgTable("payments", {
  id:           serial("id").primaryKey(),
  userId:       integer("user_id").notNull().references(() => users.id),
  amount:       numeric("amount", { precision: 10, scale: 2 }).notNull().default("0"),
  creditsAdded: integer("credits_added").notNull().default(0),
  method:       text("method"),
  notes:        text("notes"),
  createdAt:    timestamp("created_at").notNull().defaultNow(),
});

// ── GeoSim: Terrains ──────────────────────────────────────────────────────────
export const geosimTerrains = pgTable("geosim_terrains", {
  id:          serial("id").primaryKey(),
  name:        text("name").notNull(),
  description: text("description"),
  climate:     text("climate"),
  soilType:    text("soil_type"),
  avgRainfallMmPerYear: numeric("avg_rainfall_mm_per_year", { precision: 10, scale: 2 }),
  avgTempC:    numeric("avg_temp_c", { precision: 5, scale: 2 }),
  createdAt:   timestamp("created_at").notNull().defaultNow(),
});

// ── GeoSim: Plant Catalog ─────────────────────────────────────────────────────
export const geosimPlantCatalog = pgTable("geosim_plant_catalog", {
  id:                      serial("id").primaryKey(),
  name:                    text("name").notNull(),
  scientificName:          text("scientific_name"),
  category:                text("category"),
  growthRatePerYear:       numeric("growth_rate_per_year", { precision: 8, scale: 3 }),
  initialSizeM:            numeric("initial_size_m", { precision: 8, scale: 3 }),
  maxSizeM:                numeric("max_size_m", { precision: 8, scale: 3 }),
  waterNeedLPerDay:        numeric("water_need_l_per_day", { precision: 8, scale: 3 }),
  survivalProbability:     numeric("survival_probability", { precision: 5, scale: 4 }),
  pricePerUnit:            numeric("price_per_unit", { precision: 10, scale: 2 }),
  maintenanceCostPerYear:  numeric("maintenance_cost_per_year", { precision: 10, scale: 2 }),
  isActive:                boolean("is_active").notNull().default(true),
  createdAt:               timestamp("created_at").notNull().defaultNow(),
});

// ── GeoSim: Designs ───────────────────────────────────────────────────────────
export const geosimDesigns = pgTable("geosim_designs", {
  id:        serial("id").primaryKey(),
  name:      text("name").notNull(),
  terrainId: integer("terrain_id").references(() => geosimTerrains.id),
  data:      jsonb("data"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// ── GeoSim: Simulations ───────────────────────────────────────────────────────
export const geosimSimulations = pgTable("geosim_simulations", {
  id:              serial("id").primaryKey(),
  designId:        integer("design_id").references(() => geosimDesigns.id),
  years:           integer("years").notNull().default(5),
  climateMultiplier: text("climate_multiplier").notNull().default("1.0"),
  results:         jsonb("results"),
  createdAt:       timestamp("created_at").notNull().defaultNow(),
});

// ── Learning Events ───────────────────────────────────────────────────────────
export const learningEvents = pgTable("learning_events", {
  id:              serial("id").primaryKey(),
  eventType:       text("event_type").notNull(),
  inventoryItemId: integer("inventory_item_id").references(() => inventoryItems.id),
  itemName:        text("item_name"),
  itemType:        text("item_type"),
  materialId:      text("material_id"),
  style:           text("style"),
  areaM2:          text("area_m2"),
  quantity:        integer("quantity"),
  createdAt:       timestamp("created_at").notNull().defaultNow(),
});
