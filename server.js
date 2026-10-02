const express = require('express');
const session = require('express-session');
const multer = require('multer');
const csv = require('csv-parser');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: 'medtrace-hospital-secret-key-2026',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 } // 24 hours
}));

// File upload configuration
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, 'uploads');
    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + '-' + file.originalname);
  }
});
const upload = multer({ storage });

// Auth middleware
function requireAuth(req, res, next) {
  if (req.session.userId) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

// ============ AUTH ROUTES ============

app.post('/api/auth/signup', (req, res) => {
  const { username, email, password } = req.body;
  if (!username || !email || !password) {
    return res.status(400).json({ error: 'All fields are required' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }
  const existing = db.prepare('SELECT id FROM users WHERE username = ? OR email = ?').get(username, email);
  if (existing) {
    return res.status(409).json({ error: 'Username or email already exists' });
  }
  const hashed = bcrypt.hashSync(password, 10);
  const result = db.prepare('INSERT INTO users (username, email, password) VALUES (?, ?, ?)').run(username, email, hashed);
  req.session.userId = result.lastInsertRowid;
  res.json({ success: true, userId: result.lastInsertRowid, username });
});

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }
  const user = db.prepare('SELECT * FROM users WHERE username = ? OR email = ?').get(username, username);
  if (!user || !bcrypt.compareSync(password, user.password)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  req.session.userId = user.id;
  res.json({ success: true, userId: user.id, username: user.username, role: user.role });
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

app.get('/api/auth/me', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not logged in' });
  const user = db.prepare('SELECT id, username, email, role FROM users WHERE id = ?').get(req.session.userId);
  res.json(user);
});

// ============ STOCK ROUTES ============

app.get('/api/stock', requireAuth, (req, res) => {
  const items = db.prepare('SELECT * FROM stock_items ORDER BY name').all();
  res.json(items);
});

app.get('/api/stock/low', requireAuth, (req, res) => {
  const items = db.prepare('SELECT * FROM stock_items WHERE quantity <= min_quantity ORDER BY quantity ASC').all();
  res.json(items);
});

app.get('/api/stock/expiring', requireAuth, (req, res) => {
  const thirtyDaysFromNow = new Date();
  thirtyDaysFromNow.setDate(thirtyDaysFromNow.getDate() + 30);
  const dateStr = thirtyDaysFromNow.toISOString().split('T')[0];
  const items = db.prepare(`SELECT * FROM stock_items WHERE expiry_date <= ? AND expiry_date >= date('now') ORDER BY expiry_date`).all(dateStr);
  res.json(items);
});

app.get('/api/stock/expired', requireAuth, (req, res) => {
  const items = db.prepare(`SELECT * FROM stock_items WHERE expiry_date < date('now') ORDER BY expiry_date`).all();
  res.json(items);
});

app.post('/api/stock', requireAuth, (req, res) => {
  const { name, category, quantity, min_quantity, unit, expiry_date, batch_number, supplier, location } = req.body;
  if (!name || quantity === undefined || min_quantity === undefined) {
    return res.status(400).json({ error: 'Name, quantity, and min_quantity are required' });
  }
  const result = db.prepare(
    'INSERT INTO stock_items (name, category, quantity, min_quantity, unit, expiry_date, batch_number, supplier, location) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(name, category || 'General', quantity, min_quantity, unit || 'units', expiry_date || null, batch_number || null, supplier || null, location || null);
  const itemId = result.lastInsertRowid;
  db.prepare('INSERT INTO stock_history (item_id, action, quantity_change, quantity_after, notes) VALUES (?, ?, ?, ?, ?)')
    .run(itemId, 'added', quantity, quantity, 'New item added');
  res.json({ success: true, id: itemId });
});

app.put('/api/stock/:id', requireAuth, (req, res) => {
  const { id } = req.params;
  const item = db.prepare('SELECT * FROM stock_items WHERE id = ?').get(id);
  if (!item) return res.status(404).json({ error: 'Item not found' });
  const { name, category, quantity, min_quantity, unit, expiry_date, batch_number, supplier, location } = req.body;
  db.prepare(
    'UPDATE stock_items SET name=?, category=?, quantity=?, min_quantity=?, unit=?, expiry_date=?, batch_number=?, supplier=?, location=?, updated_at=CURRENT_TIMESTAMP WHERE id=?'
  ).run(name || item.name, category || item.category, quantity ?? item.quantity, min_quantity ?? item.min_quantity, unit || item.unit, expiry_date || item.expiry_date, batch_number || item.batch_number, supplier || item.supplier, location || item.location, id);
  if (quantity !== undefined && quantity !== item.quantity) {
    const change = quantity - item.quantity;
    db.prepare('INSERT INTO stock_history (item_id, action, quantity_change, quantity_after, notes) VALUES (?, ?, ?, ?, ?)')
      .run(id, 'updated', change, quantity, 'Stock updated');
  }
  res.json({ success: true });
});

app.post('/api/stock/:id/adjust', requireAuth, (req, res) => {
  const { id } = req.params;
  const { change, notes } = req.body;
  const item = db.prepare('SELECT * FROM stock_items WHERE id = ?').get(id);
  if (!item) return res.status(404).json({ error: 'Item not found' });
  const newQty = item.quantity + change;
  if (newQty < 0) return res.status(400).json({ error: 'Quantity cannot be negative' });
  db.prepare('UPDATE stock_items SET quantity=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(newQty, id);
  db.prepare('INSERT INTO stock_history (item_id, action, quantity_change, quantity_after, notes) VALUES (?, ?, ?, ?, ?)')
    .run(id, change > 0 ? 'restocked' : 'dispensed', change, newQty, notes || (change > 0 ? 'Stock added' : 'Stock dispensed'));
  res.json({ success: true, newQuantity: newQty });
});

app.delete('/api/stock/:id', requireAuth, (req, res) => {
  const { id } = req.params;
  db.prepare('DELETE FROM stock_items WHERE id = ?').run(id);
  res.json({ success: true });
});

// ============ HISTORY ROUTES ============

app.get('/api/history', requireAuth, (req, res) => {
  const history = db.prepare(`
    SELECT h.*, s.name as item_name 
    FROM stock_history h 
    JOIN stock_items s ON h.item_id = s.id 
    ORDER BY h.created_at DESC 
    LIMIT 100
  `).all();
  res.json(history);
});

app.get('/api/history/calendar', requireAuth, (req, res) => {
  const history = db.prepare(`
    SELECT h.*, s.name as item_name 
    FROM stock_history h 
    JOIN stock_items s ON h.item_id = s.id 
    ORDER BY h.created_at DESC
  `).all();
  res.json(history);
});

// ============ ALERTS ROUTES ============

app.get('/api/alerts', requireAuth, (req, res) => {
  const alerts = db.prepare(`
    SELECT a.*, s.name as item_name, s.quantity, s.min_quantity
    FROM alerts a 
    JOIN stock_items s ON a.item_id = s.id 
    WHERE a.is_read = 0 
    ORDER BY a.created_at DESC
  `).all();
  res.json(alerts);
});

app.post('/api/alerts/:id/read', requireAuth, (req, res) => {
  db.prepare('UPDATE alerts SET is_read = 1 WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// ============ FILE UPLOAD ROUTES ============

app.post('/api/upload', requireAuth, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const filePath = req.file.path;
  const results = [];
  const errors = [];

  fs.createReadStream(filePath)
    .pipe(csv())
    .on('data', (data) => results.push(data))
    .on('end', () => {
      let imported = 0;
      const validationIssues = [];
      const serialMap = {};
      const batchMap = {};

      for (const row of results) {
        try {
          const name = row.name || row.Name || row.item_name || row.item || row.product_name || row.ProductName || row.product || row.Product;
          const quantity = parseInt(row.quantity || row.Quantity || row.qty || row.Qty || row.stock || row.Stock || 0);
          const minQuantity = parseInt(row.min_quantity || row.MinQuantity || row.min || row.Min || row.min_stock || row.MinStock || 10);
          const category = row.category || row.Category || row.type || row.Type || 'General';
          const unit = row.unit || row.Unit || row.uom || row.UOM || 'units';
          const expiryDate = row.expiry_date || row.ExpiryDate || row.expiry || row.ExpirationDate || null;
          const batchNumber = row.batch_number || row.BatchNumber || row.batch || row.Batch || row.sku || row.SKU || null;
          const supplier = row.supplier || row.Supplier || row.vendor || row.Vendor || null;
          const location = row.location || row.Location || row.warehouse_location || row.WarehouseLocation || row.warehouse || row.Warehouse || null;

          if (!name) {
            errors.push(`Row skipped: missing name`);
            continue;
          }

          // Validation: Check for duplicate serial numbers
          if (batchNumber) {
            if (serialMap[batchNumber]) {
              validationIssues.push({
                type: 'duplicate_serial',
                severity: 'high',
                message: `Duplicate serial number detected: ${batchNumber}`,
                details: `Item "${name}" has the same serial as "${serialMap[batchNumber]}"`
              });
            } else {
              serialMap[batchNumber] = name;
            }
          }

          // Validation: Check for invalid batch format
          if (batchNumber && !isValidBatchFormat(batchNumber)) {
            validationIssues.push({
              type: 'invalid_batch',
              severity: 'medium',
              message: `Invalid batch format: ${batchNumber}`,
              details: `Item "${name}" has a batch number that doesn't match the expected format (e.g., MED-001, ABC-2026-001)`
            });
          }

          // Validation: Check for missing stock
          if (quantity === 0 || isNaN(quantity)) {
            validationIssues.push({
              type: 'missing_stock',
              severity: 'high',
              message: `Missing or zero stock for: ${name}`,
              details: `Item "${name}" has ${quantity} units in stock`
            });
          }

          // Validation: Check for negative stock
          if (quantity < 0) {
            validationIssues.push({
              type: 'negative_stock',
              severity: 'high',
              message: `Negative stock for: ${name}`,
              details: `Item "${name}" has ${quantity} units (should not be negative)`
            });
          }

          // Validation: Check for missing expiry date on medical items
          if (!expiryDate && isMedicalItem(category)) {
            validationIssues.push({
              type: 'missing_expiry',
              severity: 'medium',
              message: `Missing expiry date for: ${name}`,
              details: `Medical item "${name}" should have an expiry date`
            });
          }

          // Validation: Check for expired items
          if (expiryDate && new Date(expiryDate) < new Date()) {
            validationIssues.push({
              type: 'expired_item',
              severity: 'high',
              message: `Expired item: ${name}`,
              details: `Item "${name}" expired on ${expiryDate}`
            });
          }

          const result = db.prepare(
            'INSERT INTO stock_items (name, category, quantity, min_quantity, unit, expiry_date, batch_number, supplier, location) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
          ).run(name, category, quantity, minQuantity, unit, expiryDate, batchNumber, supplier, location);
          const itemId = result.lastInsertRowid;
          db.prepare('INSERT INTO stock_history (item_id, action, quantity_change, quantity_after, notes) VALUES (?, ?, ?, ?, ?)')
            .run(itemId, 'imported', quantity, quantity, 'Bulk import from file');
          imported++;
        } catch (e) {
          errors.push(`Error: ${e.message}`);
        }
      }

      // Save validation issues to database
      for (const issue of validationIssues) {
        db.prepare('INSERT INTO validation_issues (item_id, type, severity, message, details) VALUES (?, ?, ?, ?, ?)')
          .run(null, issue.type, issue.severity, issue.message, issue.details);
      }

      fs.unlinkSync(filePath);
      res.json({ success: true, imported, errors, validationIssues, total: results.length });
    })
    .on('error', (err) => {
      res.status(500).json({ error: 'Failed to parse CSV file', details: err.message });
    });
});

// Validation helper functions
function isValidBatchFormat(batch) {
  // Accept formats like: MED-001, ABC-2026-001, XYZ-123, etc.
  const pattern = /^[A-Z]{2,5}-\d{3,4}(-\d{4})?$/i;
  return pattern.test(batch);
}

function isMedicalItem(category) {
  const medicalCategories = ['medication', 'drug', 'pharmaceutical', 'medical', 'antibiotic', 'analgesic', 'antidiabetic', 'emergency', 'controlled', 'gastrointestinal', 'antihistamine', 'fluid', 'vaccine', 'insulin'];
  return medicalCategories.includes((category || '').toLowerCase());
}

// ============ VALIDATION ROUTES ============

app.get('/api/validation/issues', requireAuth, (req, res) => {
  const issues = db.prepare(`
    SELECT v.*, s.name as item_name
    FROM validation_issues v
    LEFT JOIN stock_items s ON v.item_id = s.id
    WHERE v.is_resolved = 0
    ORDER BY v.created_at DESC
  `).all();
  res.json(issues);
});

app.get('/api/validation/summary', requireAuth, (req, res) => {
  const total = db.prepare('SELECT COUNT(*) as count FROM validation_issues WHERE is_resolved = 0').get().count;
  const high = db.prepare("SELECT COUNT(*) as count FROM validation_issues WHERE is_resolved = 0 AND severity = 'high'").get().count;
  const medium = db.prepare("SELECT COUNT(*) as count FROM validation_issues WHERE is_resolved = 0 AND severity = 'medium'").get().count;
  const low = db.prepare("SELECT COUNT(*) as count FROM validation_issues WHERE is_resolved = 0 AND severity = 'low'").get().count;

  const byType = db.prepare('SELECT type, COUNT(*) as count FROM validation_issues WHERE is_resolved = 0 GROUP BY type').all();

  res.json({ total, high, medium, low, byType });
});

app.post('/api/validation/:id/resolve', requireAuth, (req, res) => {
  db.prepare('UPDATE validation_issues SET is_resolved = 1 WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// Run validation on existing stock
app.post('/api/validation/scan', requireAuth, (req, res) => {
  const issues = [];
  const items = db.prepare('SELECT * FROM stock_items').all();

  // Check for duplicate serials in existing data
  const serialMap = {};
  for (const item of items) {
    if (item.batch_number) {
      if (serialMap[item.batch_number]) {
        issues.push({
          type: 'duplicate_serial',
          severity: 'high',
          message: `Duplicate serial: ${item.batch_number}`,
          details: `"${item.name}" and "${serialMap[item.batch_number]}" share the same serial`
        });
      } else {
        serialMap[item.batch_number] = item.name;
      }
    }

    // Check for invalid batch format
    if (item.batch_number && !isValidBatchFormat(item.batch_number)) {
      issues.push({
        type: 'invalid_batch',
        severity: 'medium',
        message: `Invalid batch format: ${item.batch_number}`,
        details: `Item "${item.name}" has invalid batch format`
      });
    }

    // Check for zero stock
    if (item.quantity === 0) {
      issues.push({
        type: 'missing_stock',
        severity: 'high',
        message: `Zero stock: ${item.name}`,
        details: `Item "${item.name}" has 0 units`
      });
    }

    // Check for expired items
    if (item.expiry_date && new Date(item.expiry_date) < new Date()) {
      issues.push({
        type: 'expired_item',
        severity: 'high',
        message: `Expired: ${item.name}`,
        details: `Expired on ${item.expiry_date}`
      });
    }
  }

  // Save new issues
  for (const issue of issues) {
    db.prepare('INSERT INTO validation_issues (item_id, type, severity, message, details) VALUES (?, ?, ?, ?, ?)')
      .run(null, issue.type, issue.severity, issue.message, issue.details);
  }

  res.json({ success: true, issuesFound: issues.length, issues });
});

// ============ AI CHATBOT ROUTES ============

app.post('/api/chat', requireAuth, (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'Message required' });

  // Save user message
  db.prepare('INSERT INTO chat_messages (user_id, role, content) VALUES (?, ?, ?)')
    .run(req.session.userId, 'user', message);

  // Generate AI response
  const response = generateAIResponse(message);

  // Save AI response
  db.prepare('INSERT INTO chat_messages (user_id, role, content) VALUES (?, ?, ?)')
    .run(req.session.userId, 'assistant', response);

  res.json({ response });
});

app.get('/api/chat/history', requireAuth, (req, res) => {
  const messages = db.prepare('SELECT role, content, created_at FROM chat_messages WHERE user_id = ? ORDER BY created_at DESC LIMIT 50').all(req.session.userId);
  res.json(messages.reverse());
});

// ============ AI CHATBOT ENGINE ============

function generateAIResponse(message) {
  const msg = message.toLowerCase().trim();

  // Greeting
  if (msg.match(/^(hi|hello|hey|greetings|good morning|good afternoon|good evening)/)) {
    return "Hello! I'm MedTrace AI, your hospital stock tracking assistant. I can help you with:\n\n" +
      "• **Stock Levels** - Check current inventory\n" +
      "• **Low Stock Alerts** - See what needs reordering\n" +
      "• **Expiry Warnings** - Items expiring soon\n" +
      "• **Stock Suggestions** - Reorder recommendations\n" +
      "• **Item Lookup** - Find specific items\n\n" +
      "What would you like to know?";
  }

  // Low stock query
  if (msg.match(/(low stock|running low|need reorder|reorder|below minimum|shortage)/)) {
    const lowItems = db.prepare('SELECT * FROM stock_items WHERE quantity <= min_quantity ORDER BY quantity ASC').all();
    if (lowItems.length === 0) return "Great news! No items are currently below minimum stock levels.";
    let response = `⚠️ **Low Stock Alert** - ${lowItems.length} item(s) need attention:\n\n`;
    lowItems.forEach(item => {
      const deficit = item.min_quantity - item.quantity;
      response += `• **${item.name}**: ${item.quantity} ${item.unit} (min: ${item.min_quantity}) - Need ${deficit} more\n`;
    });
    response += "\n💡 **Suggestion**: Consider placing a reorder for these items soon to avoid stockouts.";
    return response;
  }

  // Expiry query
  if (msg.match(/(expir|expiry|expiration|expired|going bad|shelf life)/)) {
    const expired = db.prepare(`SELECT * FROM stock_items WHERE expiry_date < date('now')`).all();
    const expiringSoon = db.prepare(`SELECT * FROM stock_items WHERE expiry_date >= date('now') AND expiry_date <= date('now', '+30 days')`).all();
    let response = "";
    if (expired.length > 0) {
      response += `🚨 **EXPIRED Items** (${expired.length}):\n`;
      expired.forEach(item => { response += `• ${item.name} (Batch: ${item.batch_number || 'N/A'}) - Expired: ${item.expiry_date}\n`; });
      response += "\n";
    }
    if (expiringSoon.length > 0) {
      response += `⚠️ **Expiring Within 30 Days** (${expiringSoon.length}):\n`;
      expiringSoon.forEach(item => { response += `• ${item.name} - Expires: ${item.expiry_date} (${item.quantity} ${item.unit})\n`; });
    }
    if (!response) return "No items are expiring within the next 30 days. Great job managing expiry!";
    response += "\n💡 **FEFE Suggestion**: Use First-Expired-First-Out approach. Prioritize dispensing items with earlier expiry dates.";
    return response;
  }

  // Stock overview
  if (msg.match(/(overview|summary|total stock|inventory|all stock|dashboard|status)/)) {
    const total = db.prepare('SELECT COUNT(*) as count, SUM(quantity) as total_qty FROM stock_items').get();
    const low = db.prepare('SELECT COUNT(*) as count FROM stock_items WHERE quantity <= min_quantity').get();
    const expiring = db.prepare(`SELECT COUNT(*) as count FROM stock_items WHERE expiry_date <= date('now', '+30 days') AND expiry_date >= date('now')`).get();
    const expired = db.prepare(`SELECT COUNT(*) as count FROM stock_items WHERE expiry_date < date('now')`).get();
    const categories = db.prepare('SELECT category, COUNT(*) as count FROM stock_items GROUP BY category').all();

    let response = "📊 **Stock Overview**\n\n" +
      `• Total Items: ${total.count}\n` +
      `• Total Quantity: ${total.total_qty || 0} units\n` +
      `• Low Stock Items: ${low.count}\n` +
      `• Expiring Soon (30 days): ${expiring.count}\n` +
      `• Expired: ${expired.count}\n\n` +
      "**Categories:**\n";
    categories.forEach(c => { response += `• ${c.category}: ${c.count} items\n`; });
    return response;
  }

  // Search for specific item
  const searchMatch = msg.match(/(search|find|look for|where is|check|show)\s+(.+)/);
  if (searchMatch) {
    const searchTerm = searchMatch[2].trim();
    const items = db.prepare('SELECT * FROM stock_items WHERE name LIKE ?').all(`%${searchTerm}%`);
    if (items.length === 0) return `No items found matching "${searchTerm}". Try a different search term.`;
    let response = `🔍 **Search Results** for "${searchTerm}" (${items.length} found):\n\n`;
    items.forEach(item => {
      const status = item.quantity <= item.min_quantity ? '⚠️ LOW' : '✅ OK';
      response += `• **${item.name}** - ${item.quantity} ${item.unit} ${status}\n`;
      response += `  Category: ${item.category} | Location: ${item.location || 'N/A'} | Expiry: ${item.expiry_date || 'N/A'}\n`;
    });
    return response;
  }

  // Add stock
  if (msg.match(/(add|restock|receive|new stock|supply)/)) {
    return "To add stock, you can:\n\n" +
      "1. **Upload a CSV file** - Go to the Upload page and upload a CSV with columns: name, quantity, min_quantity, category, unit, expiry_date, batch_number, supplier, location\n\n" +
      "2. **Add manually** - Go to the Stock page and click 'Add Item'\n\n" +
      "3. **Adjust quantity** - Use the +/- buttons on any stock item\n\n" +
      "Would you like me to show you the CSV format?";
  }

  // Help
  if (msg.match(/(help|what can you do|commands|features|how to)/)) {
    return "🤖 **MedTrace AI - Help Guide**\n\n" +
      "**Stock Management:**\n" +
      "• \"Show low stock\" - Items below minimum\n" +
      "• \"Expiring soon\" - Items expiring in 30 days\n" +
      "• \"Stock overview\" - Complete inventory summary\n" +
      "• \"Search [item name]\" - Find specific items\n\n" +
      "**Suggestions:**\n" +
      "• \"What should I reorder?\" - Get reorder suggestions\n" +
      "• \"Give me suggestions\" - General recommendations\n\n" +
      "**Tips:**\n" +
      "• Upload CSV files to bulk import stock\n" +
      "• Check the Calendar view for stock history\n" +
      "• Set appropriate min_quantity for each item\n\n" +
      "How can I assist you further?";
  }

  // Reorder suggestions
  if (msg.match(/(suggest|recommend|what should|advice|tips)/)) {
    const lowItems = db.prepare('SELECT * FROM stock_items WHERE quantity <= min_quantity ORDER BY (quantity * 1.0 / min_quantity) ASC').all();
    const expiring = db.prepare(`SELECT * FROM stock_items WHERE expiry_date <= date('now', '+30 days') AND expiry_date >= date('now') ORDER BY expiry_date`).all();
    let response = "💡 **AI Suggestions & Recommendations**\n\n";

    if (lowItems.length > 0) {
      response += "**🔴 Priority Reorders:**\n";
      lowItems.slice(0, 5).forEach(item => {
        const suggested = Math.max(item.min_quantity * 2 - item.quantity, item.min_quantity);
        response += `• ${item.name}: Order ~${suggested} ${item.unit} (current: ${item.quantity}, min: ${item.min_quantity})\n`;
      });
      response += "\n";
    }

    if (expiring.length > 0) {
      response += "**🟡 Expiry Management:**\n";
      expiring.slice(0, 3).forEach(item => {
        response += `• ${item.name}: ${item.quantity} ${item.unit} expiring on ${item.expiry_date} - Consider FEFO dispensing\n`;
      });
      response += "\n";
    }

    if (lowItems.length === 0 && expiring.length === 0) {
      response += "✅ All stock levels are healthy! No immediate action needed.\n\n";
    }

    response += "**📋 General Best Practices:**\n" +
      "• Maintain safety stock at 1.5x minimum quantity\n" +
      "• Review expiry dates weekly\n" +
      "• Use FEFO (First-Expired-First-Out) for dispensing\n" +
      "• Keep par levels updated based on usage trends";
    return response;
  }

  // Default response
  return "I'm here to help with hospital stock tracking! Try asking me:\n\n" +
    "• \"What's running low?\" - Check low stock items\n" +
    "• \"Show expiring items\" - Expiry warnings\n" +
    "• \"Stock overview\" - Full inventory summary\n" +
    "• \"Search [item]\" - Find specific items\n" +
    "• \"Give suggestions\" - Get AI recommendations\n" +
    "• \"Help\" - See all commands\n\n" +
    "What would you like to know?";
}

// ============ START SERVER ============

app.listen(PORT, () => {
  console.log(`\n🏥 MedTrace Hospital Stock Tracker`);
  console.log(`   Server running at http://localhost:${PORT}`);
  console.log(`   Default login: admin / admin123\n`);
});
