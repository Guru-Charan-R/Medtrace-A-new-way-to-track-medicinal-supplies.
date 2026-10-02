const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'medtrace.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    role TEXT DEFAULT 'staff',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS stock_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    category TEXT DEFAULT 'General',
    quantity INTEGER NOT NULL DEFAULT 0,
    min_quantity INTEGER NOT NULL DEFAULT 10,
    unit TEXT DEFAULT 'units',
    expiry_date TEXT,
    batch_number TEXT,
    supplier TEXT,
    location TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS stock_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id INTEGER,
    action TEXT NOT NULL,
    quantity_change INTEGER NOT NULL,
    quantity_after INTEGER NOT NULL,
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (item_id) REFERENCES stock_items(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id INTEGER,
    type TEXT NOT NULL,
    message TEXT NOT NULL,
    is_read INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (item_id) REFERENCES stock_items(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS validation_issues (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id INTEGER,
    type TEXT NOT NULL,
    severity TEXT NOT NULL,
    message TEXT NOT NULL,
    details TEXT,
    is_resolved INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (item_id) REFERENCES stock_items(id) ON DELETE CASCADE
  );
`);

// Seed default admin user if not exists
const bcrypt = require('bcryptjs');
const adminExists = db.prepare('SELECT id FROM users WHERE username = ?').get('admin');
if (!adminExists) {
  const hashedPassword = bcrypt.hashSync('admin123', 10);
  db.prepare('INSERT INTO users (username, email, password, role) VALUES (?, ?, ?, ?)')
    .run('admin', 'admin@medtrace.com', hashedPassword, 'admin');
}

// Seed sample stock data if empty
const stockCount = db.prepare('SELECT COUNT(*) as count FROM stock_items').get().count;
if (stockCount === 0) {
  const sampleItems = [
    ['Paracetamol 500mg', 'Analgesic', 500, 100, 'tablets', '2026-12-31', 'PCM-2026-001', 'PharmaCorp', 'Shelf A1'],
    ['Amoxicillin 250mg', 'Antibiotic', 200, 50, 'capsules', '2026-06-30', 'AMX-2026-002', 'MediSupply', 'Shelf A2'],
    ['Insulin Glargine', 'Antidiabetic', 80, 30, 'vials', '2026-03-15', 'INS-2026-003', 'ColdChain Pharma', 'Refrigerator B1'],
    ['Surgical Masks (Box)', 'PPE', 150, 50, 'boxes', '2027-01-31', 'PPE-2026-004', 'SafetyFirst', 'Storage C1'],
    ['N95 Respirators', 'PPE', 45, 30, 'units', '2027-06-30', 'N95-2026-005', 'SafetyFirst', 'Storage C2'],
    ['IV Saline 500ml', 'Fluid', 120, 40, 'bags', '2026-09-30', 'SAL-2026-006', 'MediSupply', 'Shelf B1'],
    ['Bandage Roll 4in', 'Wound Care', 300, 100, 'rolls', '2028-01-31', 'BND-2026-007', 'CarePlus', 'Shelf D1'],
    ['Antiseptic Solution', 'Disinfectant', 25, 20, 'bottles', '2026-04-30', 'ANT-2026-008', 'CleanMed', 'Shelf E1'],
    ['Digital Thermometer', 'Equipment', 60, 15, 'units', '2029-12-31', 'THM-2026-009', 'TechMed', 'Drawer F1'],
    ['Blood Pressure Monitor', 'Equipment', 35, 10, 'units', '2029-06-30', 'BPM-2026-010', 'TechMed', 'Drawer F2'],
    ['Omeprazole 20mg', 'Gastrointestinal', 180, 60, 'capsules', '2026-08-31', 'OMP-2026-011', 'PharmaCorp', 'Shelf A3'],
    ['Cetirizine 10mg', 'Antihistamine', 250, 80, 'tablets', '2027-03-31', 'CET-2026-012', 'AllergyRelief Inc', 'Shelf A4'],
  ];

  const insertStmt = db.prepare(
    'INSERT INTO stock_items (name, category, quantity, min_quantity, unit, expiry_date, batch_number, supplier, location) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  );

  for (const item of sampleItems) {
    insertStmt.run(...item);
    const itemId = db.prepare('SELECT last_insert_rowid() as id').get().id;
    db.prepare('INSERT INTO stock_history (item_id, action, quantity_change, quantity_after, notes) VALUES (?, ?, ?, ?, ?)')
      .run(itemId, 'initial', item[2], item[2], 'Initial stock entry');
  }
}

module.exports = db;
