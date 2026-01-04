const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
require('dotenv').config();
const axios = require('axios');
// const session = require('express-session');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const { MongoClient, ObjectId } = require('mongodb');
const Razorpay = require('razorpay');
const PDFDocument = require('pdfkit');
const bcrypt = require('bcrypt');

// Configure Multer
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const dir = 'public/uploads';
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    cb(null, dir);
  },
  filename: function (req, file, cb) {
    // Unique filename: timestamp-random-originalName
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({ storage: storage });

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static('public'));

// Session Middleware (Removed/Commented out for JWT)
/*
app.use(session({
  secret: process.env.SESSION_SECRET || 'secret',
  resave: false,
  saveUninitialized: true,
  cookie: { secure: false } // Set to true if using https
}));
*/

// JWT Middleware
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) return res.status(401).json({ success: false, message: 'No token provided' });

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ success: false, message: 'Invalid token' });
    req.user = user;
    next();
  });
};

// Data Store (MongoDB)
const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = process.env.DB_NAME || 'event_hall_booking';

let db;
let usersCollection;
let hallsCollection;
let bookingsCollection;
let bookingModificationsCollection;
let waitlistCollection;
let otps = {}; // Keep OTPs in memory (they are temporary)

// Password Hashing Helper Functions
const SALT_ROUNDS = 10;

async function hashPassword(password) {
  try {
    const salt = await bcrypt.genSalt(SALT_ROUNDS);
    const hashedPassword = await bcrypt.hash(password, salt);
    return hashedPassword;
  } catch (error) {
    console.error('Error hashing password:', error);
    throw error;
  }
}

async function comparePassword(plainPassword, hashedPassword) {
  try {
    return await bcrypt.compare(plainPassword, hashedPassword);
  } catch (error) {
    console.error('Error comparing password:', error);
    return false;
  }
}

// MongoDB Connection
const mongoClient = new MongoClient(MONGODB_URI);

async function connectDB() {
  try {
    await mongoClient.connect();
    console.log('✅ Connected to MongoDB Atlas');

    db = mongoClient.db(DB_NAME);
    usersCollection = db.collection('users');
    hallsCollection = db.collection('halls');
    bookingsCollection = db.collection('bookings');
    bookingModificationsCollection = db.collection('booking_modifications');
    waitlistCollection = db.collection('waitlist');

    // Create indexes for better performance
    await usersCollection.createIndex({ email: 1 }, { unique: true });
    await hallsCollection.createIndex({ status: 1 });
    await hallsCollection.createIndex({ ownerId: 1 });
    await bookingsCollection.createIndex({ hallId: 1, date: 1 });
    await bookingsCollection.createIndex({ userId: 1 });
    await bookingModificationsCollection.createIndex({ bookingId: 1 });
    await bookingModificationsCollection.createIndex({ status: 1 });
    await waitlistCollection.createIndex({ hallId: 1, date: 1 });
    await waitlistCollection.createIndex({ userId: 1 });
    await waitlistCollection.createIndex({ createdAt: 1 });
    await waitlistCollection.createIndex({ status: 1 });

    // Ensure admin exists
    const adminExists = await usersCollection.findOne({ role: 'admin' });
    if (!adminExists) {
      const hashedPassword = await hashPassword('admin123');
      await usersCollection.insertOne({
        name: 'Admin User',
        email: 'admin@gmail.com',
        password: hashedPassword,
        role: 'admin',
        phone: '0000000000',
        createdAt: new Date()
      });
      console.log('✅ Admin user created');
    }
  } catch (error) {
    console.error('❌ MongoDB Connection Error:', error);
    process.exit(1);
  }
}

// Initialize Razorpay
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET
});

// Helper: Remove Duplicate Halls
async function removeDuplicateHalls() {
  try {
    const allHalls = await hallsCollection.find({}).toArray();
    const seen = new Set();
    const duplicates = [];

    for (const hall of allHalls) {
      const key = `${hall.name}-${hall.location}`.toLowerCase(); // Simple composite key
      if (seen.has(key)) {
        duplicates.push(hall._id);
      } else {
        seen.add(key);
      }
    }

    if (duplicates.length > 0) {
      console.log(`🗑️ Found ${duplicates.length} duplicate halls. Removing...`);
      await hallsCollection.deleteMany({ _id: { $in: duplicates } });
      console.log('✅ Duplicates removed.');
    } else {
      console.log('✅ No duplicate halls found.');
    }
  } catch (error) {
    console.error('Error removing duplicates:', error);
  }
}

// Helper: Update All Prices to 1 (Requested by User)
async function updateAllPricesToOne() {
  try {
    const result = await hallsCollection.updateMany(
      {}, // match all
      { $set: { price: 1 } }
    );
    console.log(`✅ Updated ${result.modifiedCount} halls to price 1.`);
  } catch (error) {
    console.error('Error updating prices:', error);
  }
}

// Helper: Read/Write Data (kept for backward compatibility, not used with MongoDB)

// Brevo Email Service
const sendBrevoEmail = async (to, subject, html) => {
  try {
    const response = await axios.post('https://api.brevo.com/v3/smtp/email', {
      sender: {
        name: 'Event Hall Booking',
        email: process.env.SMTP_EMAIL
      },
      to: [{ email: to }],
      subject: subject,
      htmlContent: html
    }, {
      headers: {
        'api-key': process.env.BREVO_API_KEY,
        'Content-Type': 'application/json'
      }
    });
    console.log('✅ Email sent successfully via Brevo');
    return response.data;
  } catch (error) {
    console.error('⚠️ Brevo Email Error:', error.response?.data || error.message);
    // Don't throw - allow app to continue even if email fails
    return { error: true, message: 'Email failed but registration continues' };
  }
};

// Remove global currentUser variable
// let currentUser = null;

// Routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Auth Routes
app.post('/api/register', async (req, res) => {
  const { name, email, password, phone } = req.body; // Role ignored from client

  try {
    const existingUser = await usersCollection.findOne({ email });
    if (existingUser) {
      return res.status(409).json({ success: false, message: 'Email already exists' });
    }

    // Generate 6 digit OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();

    // Store pending registration (force role: user)
    otps[email] = {
      code: otp,
      expires: Date.now() + 10 * 60 * 1000,
      userData: { name, email, password, phone, role: 'user', createdAt: new Date() },
      type: 'signup'
    };

    try {
      const htmlContent = `
        <h2>Verify Your Signup</h2>
        <p>Your OTP for account verification is: <strong>${otp}</strong></p>
        <p>This OTP is valid for 10 minutes.</p>
      `;
      await sendBrevoEmail(email, 'Verify your Signup - Event Hall Booking', htmlContent);
      res.json({ success: true, requireOtp: true, message: 'OTP sent to email' });
    } catch (error) {
      console.error('Brevo Error:', error);
      res.status(500).json({ success: false, message: 'Failed to send OTP' });
    }
  } catch (error) {
    console.error('Register Error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Admin Create Owner Route
app.post('/api/admin/create-owner', authenticateToken, async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ success: false, message: 'Unauthorized' });
  }

  const { name, email, phone, password } = req.body;

  try {
    const existingUser = await usersCollection.findOne({ email });
    if (existingUser) {
      return res.status(409).json({ success: false, message: 'Email already exists' });
    }

    // Hash password before storing
    const hashedPassword = await hashPassword(password);

    const newOwner = {
      name,
      email,
      phone,
      password: hashedPassword,
      role: 'owner',
      createdAt: new Date()
    };

    const result = await usersCollection.insertOne(newOwner);

    // Send Welcome Email
    try {
      const htmlContent = `
        <h1>Welcome, ${name}!</h1>
        <p>Your Owner account has been created by the administrator.</p>
        <p>You can now log in to list and manage your event halls.</p>
        <br>
        <p><strong>Login Credentials:</strong></p>
        <p>Email: ${email}</p>
        <p>Password: ${password}</p>
        <br>
        <p><a href="http://localhost:3000/login.html">Click here to Login</a></p>
      `;
      await sendBrevoEmail(email, 'Welcome to Event Hall Booking - Owner Account', htmlContent);
      res.json({ success: true, message: 'Owner created and email sent' });
    } catch (error) {
      console.error('Brevo Error:', error);
      // User created but email failed
      res.json({ success: true, message: 'Owner created but email failed to send' });
    }
  } catch (error) {
    console.error('Create Owner Error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

app.post('/api/verify-signup', async (req, res) => {
  const { email, otp } = req.body;
  const storedOtp = otps[email];

  if (!storedOtp || storedOtp.type !== 'signup') {
    return res.status(422).json({ success: false, message: 'No signup verification pending for this email' });
  }

  if (Date.now() > storedOtp.expires) {
    delete otps[email];
    return res.status(410).json({ success: false, message: 'OTP expired' });
  }

  if (storedOtp.code !== otp) {
    return res.status(422).json({ success: false, message: 'Invalid OTP' });
  }

  try {
    // Create User with hashed password
    const newUser = storedOtp.userData;
    newUser.password = await hashPassword(newUser.password);
    const result = await usersCollection.insertOne(newUser);

    // Generate Token
    const user = await usersCollection.findOne({ email });
    const token = jwt.sign({ id: user._id.toString(), email: user.email, role: user.role, name: user.name }, process.env.JWT_SECRET);
    delete otps[email]; // Clear OTP

    res.json({ success: true, token, user: { ...user, password: undefined } });
  } catch (error) {
    console.error('Verify Signup Error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;

  try {
    const user = await usersCollection.findOne({ email });

    if (user) {
      // Compare password with hashed password
      const isPasswordValid = await comparePassword(password, user.password);
      
      if (isPasswordValid) {
        // Generate Token
        const token = jwt.sign({ id: user._id.toString(), email: user.email, role: user.role, name: user.name }, process.env.JWT_SECRET);
        res.json({ success: true, token, user: { ...user, password: undefined } });
      } else {
        res.status(401).json({ success: false, message: 'Invalid credentials' });
      }
    } else {
      res.status(401).json({ success: false, message: 'Invalid credentials' });
    }
  } catch (error) {
    console.error('Login Error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

app.get('/api/current-user', authenticateToken, (req, res) => {
  res.json({ success: true, user: req.user });
});

app.post('/api/logout', (req, res) => {
  // Client-side logout (clear token)
  res.json({ success: true });
});

// Password Reset Routes
app.post('/api/forgot-password', async (req, res) => {
  const { email } = req.body;

  try {
    const user = await usersCollection.findOne({ email });

    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    // Generate 6 digit OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();

    // Store OTP (valid for 10 mins)
    otps[email] = {
      code: otp,
      expires: Date.now() + 10 * 60 * 1000
    };

    try {
      const htmlContent = `
        <h2>Password Reset Request</h2>
        <p>Your OTP for password reset is: <strong>${otp}</strong></p>
        <p>This OTP is valid for 10 minutes.</p>
      `;
      await sendBrevoEmail(email, 'Password Reset OTP - Event Hall Booking', htmlContent);
      res.json({ success: true, message: 'OTP sent to email' });
    } catch (error) {
      console.error('Brevo Error:', error);
      res.status(500).json({ success: false, message: 'Failed to send OTP' });
    }
  } catch (error) {
    console.error('Forgot Password Error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

app.post('/api/verify-otp', (req, res) => {
  const { email, otp } = req.body;
  const storedOtp = otps[email];

  if (!storedOtp) {
    return res.status(422).json({ success: false, message: 'No OTP requested or expired' });
  }

  if (Date.now() > storedOtp.expires) {
    delete otps[email];
    return res.status(410).json({ success: false, message: 'OTP expired' });
  }

  if (storedOtp.code === otp) {
    res.json({ success: true, message: 'OTP verified' });
  } else {
    res.status(422).json({ success: false, message: 'Invalid OTP' });
  }
});

app.post('/api/reset-password', async (req, res) => {
  const { email, otp, newPassword } = req.body;
  const storedOtp = otps[email];

  if (!storedOtp || storedOtp.code !== otp || Date.now() > storedOtp.expires) {
    return res.status(410).json({ success: false, message: 'Invalid or expired OTP' });
  }

  try {
    // Hash new password before storing
    const hashedPassword = await hashPassword(newPassword);
    const result = await usersCollection.updateOne({ email }, { $set: { password: hashedPassword } });

    if (result.matchedCount > 0) {
      delete otps[email]; // Consume OTP
      res.json({ success: true, message: 'Password reset successfully' });
    } else {
      res.status(404).json({ success: false, message: 'User not found' });
    }
  } catch (error) {
    console.error('Reset Password Error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Helper: Calculate Distance (Haversine Formula) in km
function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371; // Radius of the earth in km
  const dLat = deg2rad(lat2 - lat1);
  const dLon = deg2rad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(deg2rad(lat1)) * Math.cos(deg2rad(lat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const d = R * c; // Distance in km
  return d;
}

function deg2rad(deg) {
  return deg * (Math.PI / 180);
}

// =========================
// Hall Routes
// =========================

// Helper: date utilities (used for availability + pricing)
function normalizeDateString(dateStr) {
  // Always keep dates in YYYY-MM-DD format
  return new Date(dateStr).toISOString().split('T')[0];
}

function isWeekend(dateStr) {
  const d = new Date(dateStr);
  const day = d.getUTCDay(); // 0 (Sun) - 6 (Sat)
  return day === 0 || day === 6;
}

// Simple peak season example: Oct–Feb (weddings, year-end events)
function isPeakSeason(dateStr) {
  const month = new Date(dateStr).getUTCMonth() + 1; // 1-12
  return month === 10 || month === 11 || month === 12 || month === 1 || month === 2;
}

function isLastMinute(dateStr) {
  const target = new Date(dateStr);
  const today = new Date();
  const diffMs = target.setHours(0, 0, 0, 0) - today.setHours(0, 0, 0, 0);
  const diffDays = diffMs / (1000 * 60 * 60 * 24);
  return diffDays >= 0 && diffDays <= 3;
}

// Core dynamic pricing logic (kept modular for future AI/ML upgrade)
function calculateDynamicPrice(hall, dateStr, options = {}) {
  /**
   * options:
   *  - baseOverrides: allow custom base price (optional)
   *  - guestCount: number (optional, for per-guest addons)
   *  - selectedAddons: array of addon keys to include from hall.addons
   */
  const normalizedDate = normalizeDateString(dateStr);
  const basePrice = options.baseOverrides || hall.price || 0;

  let total = basePrice;
  const breakdown = {
    basePrice,
    weekdayWeekendAdjustment: 0,
    peakSeasonAdjustment: 0,
    lastMinuteAdjustment: 0,
    addonsTotal: 0
  };

  // Weekday vs Weekend pricing
  if (isWeekend(normalizedDate)) {
    const weekendExtra = Math.round(basePrice * 0.15); // +15% on weekends
    breakdown.weekdayWeekendAdjustment = weekendExtra;
    total += weekendExtra;
  } else {
    breakdown.weekdayWeekendAdjustment = 0; // no change on weekdays for now
  }

  // Peak season pricing
  if (isPeakSeason(normalizedDate)) {
    const peakExtra = Math.round(basePrice * 0.20); // +20% in peak season
    breakdown.peakSeasonAdjustment = peakExtra;
    total += peakExtra;
  }

  // Last-minute discount (within 3 days)
  if (isLastMinute(normalizedDate)) {
    const discount = Math.round(total * 0.10); // -10% of current total
    breakdown.lastMinuteAdjustment = -discount;
    total -= discount;
  }

  // Add-ons (from hall.addons, optional)
  const guestCount = parseInt(options.guestCount || 0);
  const selectedAddons = options.selectedAddons || [];
  if (Array.isArray(hall.addons) && selectedAddons.length > 0) {
    hall.addons.forEach(addon => {
      if (!addon || !addon.key) return;
      if (!selectedAddons.includes(addon.key)) return;

      const type = addon.type || 'flat'; // 'flat' or 'per_guest'
      const amount = parseInt(addon.price || 0);
      if (!amount) return;

      if (type === 'per_guest' && guestCount > 0) {
        breakdown.addonsTotal += amount * guestCount;
      } else {
        breakdown.addonsTotal += amount;
      }
    });
    total += breakdown.addonsTotal;
  }

  breakdown.total = total;
  breakdown.date = normalizedDate;

  return breakdown;
}
app.get('/api/halls', async (req, res) => {
  const { category, location, minPrice, maxPrice, search, lat, lng, date, guestCount } = req.query;

  try {
    let query = { status: 'approved' };

    if (category && category !== 'all') {
      query.category = category;
    }

    if (location) {
      query.location = { $regex: location, $options: 'i' };
    }

    if (minPrice || maxPrice) {
      query.price = {};
      if (minPrice) query.price.$gte = parseInt(minPrice);
      if (maxPrice) query.price.$lte = parseInt(maxPrice);
    }

    if (search) {
      query.$or = [
        { name: { $regex: search, $options: 'i' } },
        { description: { $regex: search, $options: 'i' } }
      ];
    }

    let filteredHalls = await hallsCollection.find(query).toArray();

    // Ensure new fields have safe defaults to avoid frontend crashes
    filteredHalls = filteredHalls.map(h => ({
      blockedDates: [],
      addons: [],
      ...h
    }));

    // Date-based availability filter (optional)
    if (date) {
      const normalizedDate = normalizeDateString(date);

      // Find halls that are booked on this date
      const bookedOnDate = await bookingsCollection
        .find({
          date: normalizedDate,
          status: { $ne: 'cancelled' }
        })
        .project({ hallId: 1 })
        .toArray();

      const bookedHallIds = new Set(bookedOnDate.map(b => b.hallId.toString()));

      filteredHalls = filteredHalls.filter(hall => {
        const isBooked = bookedHallIds.has(hall._id.toString());
        const isBlocked =
          Array.isArray(hall.blockedDates) &&
          hall.blockedDates.includes(normalizedDate);
        return !isBooked && !isBlocked;
      });
    }

    // Capacity filter based on requested guest count
    if (guestCount) {
      const requiredGuests = parseInt(guestCount);
      if (!isNaN(requiredGuests)) {
        filteredHalls = filteredHalls.filter(h =>
          parseInt(h.capacity || 0) >= requiredGuests
        );
      }
    }

    // Distance Filter
    if (lat && lng) {
      const userLat = parseFloat(lat);
      const userLng = parseFloat(lng);

      filteredHalls = filteredHalls.map(hall => {
        const distance = (hall.lat && hall.lng) ? calculateDistance(userLat, userLng, hall.lat, hall.lng) : null;
        return { ...hall, distance };
      });

      // Sort by distance
      filteredHalls.sort((a, b) => {
        if (a.distance === null) return 1;
        if (b.distance === null) return -1;
        return a.distance - b.distance;
      });
    }

    res.json({ success: true, halls: filteredHalls });
  } catch (error) {
    console.error('Get Halls Error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

app.get('/api/halls/:id', async (req, res) => {
  try {
    const hall = await hallsCollection.findOne({ _id: new ObjectId(req.params.id) });

    if (hall) {
      // Ensure calendar/pricing-related fields always exist
      res.json({
        success: true,
        hall: {
          blockedDates: [],
          addons: [],
          ...hall
        }
      });
    } else {
      res.status(404).json({ success: false, message: 'Hall not found' });
    }
  } catch (error) {
    console.error('Get Hall Error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

app.post('/api/halls', authenticateToken, upload.array('images', 5), async (req, res) => {
  if (req.user.role !== 'owner') {
    return res.status(403).json({ success: false, message: 'Unauthorized' });
  }

  try {
    // Handle Image Uploads
    let imagePaths = [];
    if (req.files && req.files.length > 0) {
      imagePaths = req.files.map(file => `/uploads/${file.filename}`);
    } else {
      imagePaths = [
        'https://images.unsplash.com/photo-1519167758481-83f550bb49b3',
        'https://images.unsplash.com/photo-1517457373958-b7bdd4587205'
      ];
    }

    // Handle Amenities
    let amenities = req.body.amenities;
    if (!Array.isArray(amenities)) {
      if (typeof amenities === 'string') {
        amenities = [amenities];
      } else {
        amenities = [];
      }
    }

    // Handle Add-ons (optional event services managed by owners)
    // Expecting JSON string from client; fallback to empty array on parse error
    let addons = [];
    if (req.body.addons) {
      try {
        const parsed = JSON.parse(req.body.addons);
        addons = Array.isArray(parsed) ? parsed : [];
      } catch (e) {
        console.warn('Invalid addons JSON on hall create, ignoring:', e.message);
        addons = [];
      }
    }

    const newHall = {
      ...req.body,
      amenities: amenities,
      lat: req.body.lat ? parseFloat(req.body.lat) : null,
      lng: req.body.lng ? parseFloat(req.body.lng) : null,
      price: parseInt(req.body.price),
      capacity: parseInt(req.body.capacity),
      images: imagePaths,
      addons,
      blockedDates: [],
      ownerId: new ObjectId(req.user.id),
      status: 'pending',
      rating: 0,
      reviews: 0,
      createdAt: new Date()
    };

    const result = await hallsCollection.insertOne(newHall);
    newHall._id = result.insertedId;

    res.json({ success: true, hall: newHall });
  } catch (error) {
    console.error('Create Hall Error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

app.put('/api/halls/:id', authenticateToken, upload.array('images', 5), async (req, res) => {
  try {
    const hall = await hallsCollection.findOne({ _id: new ObjectId(req.params.id) });

    if (!hall) {
      return res.status(404).json({ success: false, message: 'Hall not found' });
    }

    if (req.user.role !== 'admin' && hall.ownerId.toString() !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }

    // Handle Image Updates
    let imagePaths = hall.images;
    if (req.files && req.files.length > 0) {
      imagePaths = req.files.map(file => `/uploads/${file.filename}`);
    }

    // Handle Amenities
    let amenities = req.body.amenities;
    if (amenities && !Array.isArray(amenities)) {
      if (typeof amenities === 'string') {
        amenities = amenities.includes(',') ? amenities.split(',').map(a => a.trim()) : [amenities];
      } else {
        amenities = [];
      }
    } else if (!amenities) {
      amenities = hall.amenities;
    }

    // Handle Add-ons update (owners can manage optional services and pricing)
    let addons = hall.addons || [];
    if (typeof req.body.addons === 'string') {
      try {
        const parsed = JSON.parse(req.body.addons);
        addons = Array.isArray(parsed) ? parsed : addons;
      } catch (e) {
        console.warn('Invalid addons JSON on hall update, keeping previous value:', e.message);
      }
    }

    const updateData = {
      ...req.body,
      amenities: amenities,
      lat: req.body.lat ? parseFloat(req.body.lat) : hall.lat,
      lng: req.body.lng ? parseFloat(req.body.lng) : hall.lng,
      price: req.body.price ? parseInt(req.body.price) : hall.price,
      capacity: req.body.capacity ? parseInt(req.body.capacity) : hall.capacity,
      images: imagePaths,
      addons
    };

    // Don't allow changes to these fields
    delete updateData._id;
    delete updateData.ownerId;
    delete updateData.status;
    delete updateData.rating;
    delete updateData.reviews;

    const result = await hallsCollection.updateOne(
      { _id: new ObjectId(req.params.id) },
      { $set: updateData }
    );

    const updatedHall = await hallsCollection.findOne({ _id: new ObjectId(req.params.id) });
    res.json({ success: true, hall: updatedHall });
  } catch (error) {
    console.error('Update Hall Error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

app.delete('/api/halls/:id', authenticateToken, async (req, res) => {
  try {
    const hall = await hallsCollection.findOne({ _id: new ObjectId(req.params.id) });

    if (!hall) {
      return res.status(404).json({ success: false, message: 'Hall not found' });
    }

    if (req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }

    await hallsCollection.deleteOne({ _id: new ObjectId(req.params.id) });
    res.json({ success: true });
  } catch (error) {
    console.error('Delete Hall Error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// =========================
// Availability & Booking Routes
// =========================

// Get availability calendar for a hall between two dates (inclusive)
app.get('/api/halls/:id/availability', async (req, res) => {
  const { from, to } = req.query;

  if (!from || !to) {
    return res.status(422).json({ success: false, message: 'from and to dates are required' });
  }

  try {
    const hallId = new ObjectId(req.params.id);
    const hall = await hallsCollection.findOne({ _id: hallId });
    if (!hall) {
      return res.status(404).json({ success: false, message: 'Hall not found' });
    }

    const start = new Date(from);
    const end = new Date(to);
    start.setHours(0, 0, 0, 0);
    end.setHours(0, 0, 0, 0);

    if (isNaN(start.getTime()) || isNaN(end.getTime()) || start > end) {
      return res.status(422).json({ success: false, message: 'Invalid date range' });
    }

    const normalizedBlocked = Array.isArray(hall.blockedDates)
      ? hall.blockedDates.map(normalizeDateString)
      : [];

    const bookings = await bookingsCollection
      .find({
        hallId,
        date: { $gte: normalizeDateString(from), $lte: normalizeDateString(to) },
        status: { $ne: 'cancelled' }
      })
      .project({ date: 1 })
      .toArray();

    const bookedSet = new Set(bookings.map(b => normalizeDateString(b.date)));
    const result = [];

    for (
      let d = new Date(start.getTime());
      d.getTime() <= end.getTime();
      d.setDate(d.getDate() + 1)
    ) {
      const ds = d.toISOString().split('T')[0];
      let status = 'available';
      if (normalizedBlocked.includes(ds)) status = 'blocked';
      if (bookedSet.has(ds)) status = 'booked';

      result.push({ date: ds, status });
    }

    res.json({ success: true, availability: result });
  } catch (error) {
    console.error('Get Availability Error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Owners can block/unblock specific dates for their halls
app.post('/api/halls/:id/block-dates', authenticateToken, async (req, res) => {
  const { dates, action } = req.body;

  if (!Array.isArray(dates) || dates.length === 0) {
    return res.status(422).json({ success: false, message: 'dates array is required' });
  }

  if (!['block', 'unblock'].includes(action)) {
    return res.status(422).json({ success: false, message: 'action must be block or unblock' });
  }

  try {
    const hallId = new ObjectId(req.params.id);
    const hall = await hallsCollection.findOne({ _id: hallId });
    if (!hall) {
      return res.status(404).json({ success: false, message: 'Hall not found' });
    }

    if (req.user.role !== 'admin' && hall.ownerId.toString() !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }

    const normalizedDates = dates.map(normalizeDateString);
    const currentBlocked = Array.isArray(hall.blockedDates) ? hall.blockedDates.map(normalizeDateString) : [];

    let updatedBlocked = currentBlocked;
    if (action === 'block') {
      const set = new Set(currentBlocked);
      normalizedDates.forEach(d => set.add(d));
      updatedBlocked = Array.from(set);
    } else if (action === 'unblock') {
      updatedBlocked = currentBlocked.filter(d => !normalizedDates.includes(d));
    }

    await hallsCollection.updateOne(
      { _id: hallId },
      { $set: { blockedDates: updatedBlocked } }
    );

    res.json({ success: true, blockedDates: updatedBlocked });
  } catch (error) {
    console.error('Block Dates Error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Price quote for a hall on a specific date or date range with optional add-ons
app.post('/api/halls/:id/price-quote', async (req, res) => {
  const { date, startDate, endDate, guestCount, selectedAddons } = req.body;

  if (!date && !startDate) {
    return res.status(422).json({ success: false, message: 'date or startDate is required' });
  }

  try {
    const hall = await hallsCollection.findOne({ _id: new ObjectId(req.params.id) });
    if (!hall) {
      return res.status(404).json({ success: false, message: 'Hall not found' });
    }

    let breakdown;
    if (startDate && endDate) {
      // Multi-day pricing
      const multiDayPricing = calculateMultiDayPrice(hall, startDate, endDate, {
        guestCount,
        selectedAddons
      });
      breakdown = {
        ...multiDayPricing.breakdown,
        startDate: multiDayPricing.startDate,
        endDate: multiDayPricing.endDate,
        days: multiDayPricing.days,
        dailyBreakdowns: multiDayPricing.dailyBreakdowns,
        multiDayDiscount: multiDayPricing.multiDayDiscount,
        discountPercentage: multiDayPricing.discountPercentage
      };
    } else {
      // Single date pricing
      breakdown = calculateDynamicPrice(hall, date, {
        guestCount,
        selectedAddons
      });
    }

    res.json({ success: true, breakdown });
  } catch (error) {
    console.error('Price Quote Error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Helper: Check availability for date range
async function checkDateRangeAvailability(hallId, startDate, endDate) {
  const normalizedStart = normalizeDateString(startDate);
  const normalizedEnd = normalizeDateString(endDate);

  const start = new Date(normalizedStart);
  const end = new Date(normalizedEnd);

  if (start > end) {
    return { available: false, message: 'Start date must be before end date' };
  }

  // Get hall
  const hall = await hallsCollection.findOne({ _id: hallId });
  if (!hall) {
    return { available: false, message: 'Hall not found' };
  }

  // Generate all dates in range
  const datesInRange = [];
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    datesInRange.push(normalizeDateString(d.toISOString()));
  }

  // Check for existing bookings that overlap with any date in range
  const overlappingBookings = await bookingsCollection.find({
    hallId: hallId,
    status: { $ne: 'cancelled' },
    $or: [
      // Single date bookings that overlap
      { date: { $in: datesInRange } },
      // Multi-day bookings that overlap
      {
        startDate: { $exists: true },
        endDate: { $exists: true },
        $or: [
          { startDate: { $lte: normalizedEnd }, endDate: { $gte: normalizedStart } }
        ]
      }
    ]
  }).toArray();

  if (overlappingBookings.length > 0) {
    return { available: false, message: 'Hall is already booked for some dates in this range' };
  }

  // Check for blocked dates
  const blockedDates = Array.isArray(hall.blockedDates) ? hall.blockedDates.map(normalizeDateString) : [];
  const blockedInRange = datesInRange.filter(date => blockedDates.includes(date));

  if (blockedInRange.length > 0) {
    return { available: false, message: `Hall is blocked on: ${blockedInRange.join(', ')}` };
  }

  return { available: true, dates: datesInRange };
}

// Helper: Calculate multi-day pricing with discounts
function calculateMultiDayPrice(hall, startDate, endDate, options = {}) {
  const normalizedStart = normalizeDateString(startDate);
  const normalizedEnd = normalizeDateString(endDate);

  const start = new Date(normalizedStart);
  const end = new Date(normalizedEnd);
  const days = Math.floor((end - start) / (1000 * 60 * 60 * 24)) + 1;

  // Calculate price for each day
  const dailyBreakdowns = [];
  let totalBasePrice = 0;
  let totalAdjustments = 0;
  let totalAddons = 0;

  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const dateStr = normalizeDateString(d.toISOString());
    const dayBreakdown = calculateDynamicPrice(hall, dateStr, {
      guestCount: options.guestCount,
      selectedAddons: [] // Add-ons calculated once for entire booking
    });
    dailyBreakdowns.push({ date: dateStr, breakdown: dayBreakdown });
    totalBasePrice += dayBreakdown.basePrice;
    totalAdjustments += (dayBreakdown.weekdayWeekendAdjustment || 0) +
                       (dayBreakdown.peakSeasonAdjustment || 0) +
                       (dayBreakdown.lastMinuteAdjustment || 0);
  }

  // Multi-day discount:
  // - 2-3 days: 5% discount
  // - 4-6 days: 10% discount
  // - 7+ days: 15% discount
  let discountPercentage = 0;
  if (days >= 7) {
    discountPercentage = 15;
  } else if (days >= 4) {
    discountPercentage = 10;
  } else if (days >= 2) {
    discountPercentage = 5;
  }

  const subtotal = totalBasePrice + totalAdjustments;
  const multiDayDiscount = Math.round(subtotal * (discountPercentage / 100));

  // Calculate add-ons (once for entire booking, not per day)
  const selectedAddons = options.selectedAddons || [];
  if (Array.isArray(hall.addons) && selectedAddons.length > 0) {
    hall.addons.forEach(addon => {
      if (!addon || !addon.key) return;
      if (!selectedAddons.includes(addon.key)) return;

      const type = addon.type || 'flat';
      const amount = parseInt(addon.price || 0);
      if (!amount) return;

      if (type === 'per_guest' && options.guestCount > 0) {
        totalAddons += amount * parseInt(options.guestCount);
      } else {
        totalAddons += amount;
      }
    });
  }

  const total = subtotal - multiDayDiscount + totalAddons;

  return {
    startDate: normalizedStart,
    endDate: normalizedEnd,
    days: days,
    dailyBreakdowns: dailyBreakdowns,
    subtotal: subtotal,
    multiDayDiscount: multiDayDiscount,
    discountPercentage: discountPercentage,
    addonsTotal: totalAddons,
    total: total,
    breakdown: {
      basePrice: totalBasePrice,
      adjustments: totalAdjustments,
      multiDayDiscount: multiDayDiscount,
      discountPercentage: discountPercentage,
      addonsTotal: totalAddons,
      total: total
    }
  };
}

// Create Booking (supports single date or date range)
app.post('/api/bookings', authenticateToken, async (req, res) => {
  const {
    hallId,
    date, // Single date (for backward compatibility)
    startDate, // Start date for multi-day booking
    endDate, // End date for multi-day booking
    guestCount,
    eventType,
    specialRequests,
    selectedAddons = []
  } = req.body;

  if (!hallId || (!date && !startDate)) {
    return res.status(422).json({ success: false, message: 'hallId and date (or startDate) are required' });
  }

  try {
    const hallObjectId = new ObjectId(hallId);
    const hall = await hallsCollection.findOne({ _id: hallObjectId });
    if (!hall) {
      return res.status(404).json({ success: false, message: 'Hall not found' });
    }

    let normalizedStartDate, normalizedEndDate, isMultiDay = false;

    // Support both single date and date range
    if (startDate && endDate) {
      // Multi-day booking
      normalizedStartDate = normalizeDateString(startDate);
      normalizedEndDate = normalizeDateString(endDate);
      isMultiDay = true;

      // Check availability for entire range
      const availabilityCheck = await checkDateRangeAvailability(hallObjectId, normalizedStartDate, normalizedEndDate);
      if (!availabilityCheck.available) {
        return res.status(409).json({ success: false, message: availabilityCheck.message });
      }
    } else {
      // Single date booking (backward compatibility)
      normalizedStartDate = normalizeDateString(date);
      normalizedEndDate = normalizedStartDate;

      // Check single date availability
      const existingBooking = await bookingsCollection.findOne({
        hallId: hallObjectId,
        $or: [
          { date: normalizedStartDate, status: { $ne: 'cancelled' } },
          {
            startDate: { $exists: true },
            endDate: { $exists: true },
            startDate: { $lte: normalizedStartDate },
            endDate: { $gte: normalizedStartDate },
            status: { $ne: 'cancelled' }
          }
        ]
      });

      if (existingBooking) {
        return res.status(409).json({ success: false, message: 'Hall is already booked on this date' });
      }

      const isBlocked = Array.isArray(hall.blockedDates) &&
        hall.blockedDates.map(normalizeDateString).includes(normalizedStartDate);
      if (isBlocked) {
        return res.status(409).json({ success: false, message: 'Hall is blocked on this date' });
      }
    }

    // Calculate pricing
    let breakdown, totalAmount;
    if (isMultiDay) {
      const multiDayPricing = calculateMultiDayPrice(hall, normalizedStartDate, normalizedEndDate, {
        guestCount,
        selectedAddons
      });
      breakdown = multiDayPricing.breakdown;
      totalAmount = multiDayPricing.total;
    } else {
      const singleDayBreakdown = calculateDynamicPrice(hall, normalizedStartDate, {
        guestCount,
        selectedAddons
      });
      breakdown = singleDayBreakdown;
      totalAmount = singleDayBreakdown.total;
    }

    const newBooking = {
      hallId: hallObjectId,
      userId: new ObjectId(req.user.id),
      date: normalizedStartDate, // Keep for backward compatibility
      startDate: normalizedStartDate,
      endDate: normalizedEndDate,
      isMultiDay: isMultiDay,
      status: 'confirmed',
      paymentStatus: 'paid',
      amount: totalAmount,
      priceBreakdown: breakdown,
      guestCount: guestCount ? parseInt(guestCount) : null,
      eventType: eventType || null,
      specialRequests: specialRequests || '',
      selectedAddons: Array.isArray(selectedAddons) ? selectedAddons : [],
      bookedAt: new Date()
    };

    const result = await bookingsCollection.insertOne(newBooking);
    newBooking._id = result.insertedId;

    res.json({ success: true, booking: newBooking });
  } catch (error) {
    console.error('Create Booking Error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

app.get('/api/bookings', authenticateToken, async (req, res) => {
  try {
    let query = {};

    if (req.user.role === 'user') {
      query.userId = new ObjectId(req.user.id);
    } else if (req.user.role === 'owner') {
      const ownerHalls = await hallsCollection.find({ ownerId: new ObjectId(req.user.id) }).toArray();
      const ownerHallIds = ownerHalls.map(h => h._id);
      query.hallId = { $in: ownerHallIds };
    }

    let userBookings = await bookingsCollection.find(query).sort({ bookedAt: -1 }).toArray();

    // Attach hall and user info
    const bookingsWithDetails = await Promise.all(userBookings.map(async (b) => {
      const hall = await hallsCollection.findOne({ _id: b.hallId });
      const user = await usersCollection.findOne({ _id: b.userId });
      return {
        ...b,
        hall: hall ? { name: hall.name, location: hall.location } : null,
        user: user ? { name: user.name, email: user.email } : null
      };
    }));

    res.json({ success: true, bookings: bookingsWithDetails });
  } catch (error) {
    console.error('Get Bookings Error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

app.get('/api/bookings/check/:hallId/:date', async (req, res) => {
  const { hallId, date } = req.params;
  const { endDate } = req.query; // Optional end date for range checking

  try {
    const hallObjectId = new ObjectId(hallId);
    const normalizedDate = normalizeDateString(date);

    const hall = await hallsCollection.findOne({ _id: hallObjectId });
    if (!hall) {
      return res.status(404).json({ success: false, message: 'Hall not found' });
    }

    // If endDate provided, check range availability
    if (endDate) {
      const availabilityCheck = await checkDateRangeAvailability(hallObjectId, normalizedDate, normalizeDateString(endDate));
      return res.json({ success: true, available: availabilityCheck.available, message: availabilityCheck.message });
    }

    // Single date check
    const existingBooking = await bookingsCollection.findOne({
      hallId: hallObjectId,
      status: { $ne: 'cancelled' },
      $or: [
        { date: normalizedDate },
        {
          startDate: { $exists: true },
          endDate: { $exists: true },
          startDate: { $lte: normalizedDate },
          endDate: { $gte: normalizedDate }
        }
      ]
    });

    const isBlocked =
      Array.isArray(hall.blockedDates) &&
      hall.blockedDates.map(normalizeDateString).includes(normalizedDate);

    res.json({ success: true, available: !existingBooking && !isBlocked });
  } catch (error) {
    console.error('Check Booking Error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Get Booking by ID
app.get('/api/bookings/:id', authenticateToken, async (req, res) => {
  try {
    const bookingId = new ObjectId(req.params.id);
    const booking = await bookingsCollection.findOne({ _id: bookingId });

    if (!booking) {
      return res.status(404).json({ success: false, message: 'Booking not found' });
    }

    // Check authorization
    if (req.user.role === 'user' && booking.userId.toString() !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }

    if (req.user.role === 'owner') {
      const hall = await hallsCollection.findOne({ _id: booking.hallId });
      if (!hall || hall.ownerId.toString() !== req.user.id) {
        return res.status(403).json({ success: false, message: 'Unauthorized' });
      }
    }

    // Get related data
    const hall = await hallsCollection.findOne({ _id: booking.hallId });
    const user = await usersCollection.findOne({ _id: booking.userId });

    // Get pending modifications
    const modifications = await bookingModificationsCollection
      .find({ bookingId: bookingId, status: { $ne: 'rejected' } })
      .sort({ requestedAt: -1 })
      .toArray();

    res.json({
      success: true,
      booking: {
        ...booking,
        hall: hall ? { ...hall, password: undefined } : null,
        user: user ? { ...user, password: undefined } : null,
        modifications
      }
    });
  } catch (error) {
    console.error('Get Booking Error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Request Date Change (supports single date or date range)
app.post('/api/bookings/:id/request-date-change', authenticateToken, async (req, res) => {
  const { newDate, newStartDate, newEndDate, reason } = req.body;

  if (!newDate && !newStartDate) {
    return res.status(422).json({ success: false, message: 'newDate or newStartDate is required' });
  }

  try {
    const bookingId = new ObjectId(req.params.id);
    const booking = await bookingsCollection.findOne({ _id: bookingId });

    if (!booking) {
      return res.status(404).json({ success: false, message: 'Booking not found' });
    }

    if (booking.userId.toString() !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }

    if (booking.status === 'cancelled') {
      return res.status(422).json({ success: false, message: 'Cannot modify cancelled booking' });
    }

    const hall = await hallsCollection.findOne({ _id: booking.hallId });
    if (!hall) {
      return res.status(404).json({ success: false, message: 'Hall not found' });
    }

    let oldValue, newValue, isMultiDayChange = false;

    // Determine if this is a multi-day change
    if (newStartDate && newEndDate) {
      isMultiDayChange = true;
      const normalizedNewStart = normalizeDateString(newStartDate);
      const normalizedNewEnd = normalizeDateString(newEndDate);
      const normalizedOldStart = normalizeDateString(booking.startDate || booking.date);
      const normalizedOldEnd = booking.isMultiDay ? normalizeDateString(booking.endDate) : normalizedOldStart;

      if (normalizedNewStart === normalizedOldStart && normalizedNewEnd === normalizedOldEnd) {
        return res.status(422).json({ success: false, message: 'New date range must be different from current range' });
      }

      // Check availability for new range
      const availabilityCheck = await checkDateRangeAvailability(booking.hallId, normalizedNewStart, normalizedNewEnd);
      if (!availabilityCheck.available) {
        return res.status(409).json({ success: false, message: availabilityCheck.message });
      }

      oldValue = { startDate: normalizedOldStart, endDate: normalizedOldEnd };
      newValue = { startDate: normalizedNewStart, endDate: normalizedNewEnd };
    } else {
      // Single date change
      const normalizedNewDate = normalizeDateString(newDate);
      const normalizedOldDate = normalizeDateString(booking.startDate || booking.date);

      if (normalizedNewDate === normalizedOldDate) {
        return res.status(422).json({ success: false, message: 'New date must be different from current date' });
      }

      // Check availability
      const existingBooking = await bookingsCollection.findOne({
        hallId: booking.hallId,
        status: { $ne: 'cancelled' },
        _id: { $ne: bookingId },
        $or: [
          { date: normalizedNewDate },
          {
            startDate: { $exists: true },
            endDate: { $exists: true },
            startDate: { $lte: normalizedNewDate },
            endDate: { $gte: normalizedNewDate }
          }
        ]
      });

      if (existingBooking) {
        return res.status(409).json({ success: false, message: 'New date is already booked' });
      }

      const isBlocked = Array.isArray(hall.blockedDates) &&
        hall.blockedDates.map(normalizeDateString).includes(normalizedNewDate);

      if (isBlocked) {
        return res.status(409).json({ success: false, message: 'New date is blocked by owner' });
      }

      oldValue = normalizedOldDate;
      newValue = normalizedNewDate;
    }

    // Create modification request
    const modification = {
      bookingId: bookingId,
      type: 'date_change',
      oldValue: oldValue,
      newValue: newValue,
      isMultiDay: isMultiDayChange,
      reason: reason || '',
      status: 'pending',
      requestedBy: new ObjectId(req.user.id),
      requestedAt: new Date(),
      approvedAt: null,
      approvedBy: null
    };

    const result = await bookingModificationsCollection.insertOne(modification);
    modification._id = result.insertedId;

    res.json({ success: true, modification });
  } catch (error) {
    console.error('Request Date Change Error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Request Add-on Change
app.post('/api/bookings/:id/request-addon-change', authenticateToken, async (req, res) => {
  const { addons, reason } = req.body;

  if (!Array.isArray(addons)) {
    return res.status(422).json({ success: false, message: 'addons array is required' });
  }

  try {
    const bookingId = new ObjectId(req.params.id);
    const booking = await bookingsCollection.findOne({ _id: bookingId });

    if (!booking) {
      return res.status(404).json({ success: false, message: 'Booking not found' });
    }

    if (booking.userId.toString() !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }

    if (booking.status === 'cancelled') {
      return res.status(422).json({ success: false, message: 'Cannot modify cancelled booking' });
    }

    const hall = await hallsCollection.findOne({ _id: booking.hallId });
    if (!hall) {
      return res.status(404).json({ success: false, message: 'Hall not found' });
    }

    // Calculate new price
    const newBreakdown = calculateDynamicPrice(hall, booking.date, {
      guestCount: booking.guestCount,
      selectedAddons: addons
    });

    // Create modification request
    const modification = {
      bookingId: bookingId,
      type: 'addon_change',
      oldValue: booking.selectedAddons || [],
      newValue: addons,
      oldAmount: booking.amount,
      newAmount: newBreakdown.total,
      reason: reason || '',
      status: 'pending',
      requestedBy: new ObjectId(req.user.id),
      requestedAt: new Date(),
      approvedAt: null,
      approvedBy: null
    };

    const result = await bookingModificationsCollection.insertOne(modification);
    modification._id = result.insertedId;

    res.json({ success: true, modification, newBreakdown });
  } catch (error) {
    console.error('Request Add-on Change Error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Cancel Booking (with refund policy)
app.post('/api/bookings/:id/cancel', authenticateToken, async (req, res) => {
  const { reason } = req.body;

  try {
    const bookingId = new ObjectId(req.params.id);
    const booking = await bookingsCollection.findOne({ _id: bookingId });

    if (!booking) {
      return res.status(404).json({ success: false, message: 'Booking not found' });
    }

    if (booking.userId.toString() !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }

    if (booking.status === 'cancelled') {
      return res.status(422).json({ success: false, message: 'Booking is already cancelled' });
    }

    // Calculate refund based on cancellation policy
    // Use start date for multi-day bookings
    const bookingStartDate = booking.isMultiDay && booking.startDate 
      ? new Date(booking.startDate) 
      : new Date(booking.date);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    bookingStartDate.setHours(0, 0, 0, 0);

    const daysUntilEvent = Math.floor((bookingStartDate - today) / (1000 * 60 * 60 * 24));
    const originalAmount = booking.amount || 0;

    let refundAmount = 0;
    let refundPercentage = 0;
    let refundPolicy = '';

    // Refund Policy:
    // - More than 30 days: 100% refund
    // - 15-30 days: 75% refund
    // - 7-14 days: 50% refund
    // - Less than 7 days: 25% refund
    // - Same day or past: No refund

    if (daysUntilEvent > 30) {
      refundAmount = originalAmount;
      refundPercentage = 100;
      refundPolicy = 'Full refund (cancelled more than 30 days before event)';
    } else if (daysUntilEvent >= 15) {
      refundAmount = Math.round(originalAmount * 0.75);
      refundPercentage = 75;
      refundPolicy = '75% refund (cancelled 15-30 days before event)';
    } else if (daysUntilEvent >= 7) {
      refundAmount = Math.round(originalAmount * 0.50);
      refundPercentage = 50;
      refundPolicy = '50% refund (cancelled 7-14 days before event)';
    } else if (daysUntilEvent > 0) {
      refundAmount = Math.round(originalAmount * 0.25);
      refundPercentage = 25;
      refundPolicy = '25% refund (cancelled less than 7 days before event)';
    } else {
      refundAmount = 0;
      refundPercentage = 0;
      refundPolicy = 'No refund (cancelled on or after event date)';
    }

    // Update booking status
    await bookingsCollection.updateOne(
      { _id: bookingId },
      {
        $set: {
          status: 'cancelled',
          cancelledAt: new Date(),
          cancellationReason: reason || '',
          refundAmount: refundAmount,
          refundPercentage: refundPercentage,
          refundPolicy: refundPolicy
        }
      }
    );

    // Notify waitlisted users about availability
    await notifyWaitlistedUsers(booking.hallId, booking.date);

    res.json({
      success: true,
      message: 'Booking cancelled successfully',
      refund: {
        amount: refundAmount,
        percentage: refundPercentage,
        policy: refundPolicy
      }
    });
  } catch (error) {
    console.error('Cancel Booking Error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Owner: Approve/Reject Modification Request
app.post('/api/bookings/modifications/:id/approve', authenticateToken, async (req, res) => {
  const { action } = req.body; // 'approve' or 'reject'

  if (!['approve', 'reject'].includes(action)) {
    return res.status(422).json({ success: false, message: 'action must be approve or reject' });
  }

  try {
    const modificationId = new ObjectId(req.params.id);
    const modification = await bookingModificationsCollection.findOne({ _id: modificationId });

    if (!modification) {
      return res.status(404).json({ success: false, message: 'Modification request not found' });
    }

    const booking = await bookingsCollection.findOne({ _id: modification.bookingId });
    if (!booking) {
      return res.status(404).json({ success: false, message: 'Booking not found' });
    }

    const hall = await hallsCollection.findOne({ _id: booking.hallId });
    if (!hall || hall.ownerId.toString() !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }

    if (modification.status !== 'pending') {
      return res.status(422).json({ success: false, message: 'Modification request already processed' });
    }

    if (action === 'approve') {
      // Update booking based on modification type
      if (modification.type === 'date_change') {
        // Recalculate price for new date
        const hall = await hallsCollection.findOne({ _id: booking.hallId });
        const newBreakdown = calculateDynamicPrice(hall, modification.newValue, {
          guestCount: booking.guestCount,
          selectedAddons: booking.selectedAddons || []
        });

        await bookingsCollection.updateOne(
          { _id: modification.bookingId },
          {
            $set: {
              date: modification.newValue,
              amount: newBreakdown.total,
              priceBreakdown: newBreakdown
            }
          }
        );
      } else if (modification.type === 'addon_change') {
        await bookingsCollection.updateOne(
          { _id: modification.bookingId },
          {
            $set: {
              selectedAddons: modification.newValue,
              amount: modification.newAmount,
              priceBreakdown: {
                ...booking.priceBreakdown,
                total: modification.newAmount,
                addonsTotal: modification.newAmount - (booking.priceBreakdown?.basePrice || 0)
              }
            }
          }
        );
      }

      await bookingModificationsCollection.updateOne(
        { _id: modificationId },
        {
          $set: {
            status: 'approved',
            approvedAt: new Date(),
            approvedBy: new ObjectId(req.user.id)
          }
        }
      );
    } else {
      await bookingModificationsCollection.updateOne(
        { _id: modificationId },
        {
          $set: {
            status: 'rejected',
            approvedAt: new Date(),
            approvedBy: new ObjectId(req.user.id)
          }
        }
      );
    }

    res.json({ success: true, message: `Modification request ${action}d successfully` });
  } catch (error) {
    console.error('Approve Modification Error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Get Invoice PDF
app.get('/api/bookings/:id/invoice', authenticateToken, async (req, res) => {
  try {
    const bookingId = new ObjectId(req.params.id);
    const booking = await bookingsCollection.findOne({ _id: bookingId });

    if (!booking) {
      return res.status(404).json({ success: false, message: 'Booking not found' });
    }

    // Check authorization
    if (req.user.role === 'user' && booking.userId.toString() !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }

    const hall = await hallsCollection.findOne({ _id: booking.hallId });
    const user = await usersCollection.findOne({ _id: booking.userId });

    if (!hall || !user) {
      return res.status(404).json({ success: false, message: 'Related data not found' });
    }

    // Create PDF
    const doc = new PDFDocument({ margin: 50 });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=invoice-${bookingId}.pdf`);

    doc.pipe(res);

    // Header
    doc.fontSize(20).text('INVOICE', { align: 'center' });
    doc.moveDown();
    doc.fontSize(12).text(`Invoice #: ${bookingId.toString()}`, { align: 'center' });
    doc.moveDown(2);

    // Company Info
    doc.fontSize(14).text('Event Hall Booking System', { align: 'left' });
    doc.fontSize(10).text('Email: support@eventhallbooking.com', { align: 'left' });
    doc.moveDown(2);

    // Bill To
    doc.fontSize(12).text('Bill To:', { underline: true });
    doc.fontSize(10).text(user.name);
    doc.text(user.email);
    doc.moveDown();

    // Booking Details
    doc.fontSize(12).text('Booking Details:', { underline: true });
    doc.fontSize(10);
    doc.text(`Venue: ${hall.name}`);
    doc.text(`Location: ${hall.location}`);
    if (booking.isMultiDay && booking.startDate && booking.endDate) {
      const startDate = new Date(booking.startDate);
      const endDate = new Date(booking.endDate);
      const days = Math.floor((endDate - startDate) / (1000 * 60 * 60 * 24)) + 1;
      doc.text(`Date Range: ${startDate.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })} - ${endDate.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}`);
      doc.text(`Duration: ${days} day(s)`);
    } else {
      doc.text(`Date: ${new Date(booking.date || booking.startDate).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}`);
    }
    if (booking.guestCount) doc.text(`Guests: ${booking.guestCount}`);
    if (booking.eventType) doc.text(`Event Type: ${booking.eventType}`);
    doc.moveDown();

    // Price Breakdown
    doc.fontSize(12).text('Price Breakdown:', { underline: true });
    doc.fontSize(10);
    if (booking.priceBreakdown) {
      if (booking.isMultiDay && booking.priceBreakdown.days) {
        doc.text(`Base Price (${booking.priceBreakdown.days} days): ${formatCurrencyPDF(booking.priceBreakdown.basePrice || 0)}`);
        if (booking.priceBreakdown.adjustments) {
          doc.text(`Date Adjustments: ${formatCurrencyPDF(booking.priceBreakdown.adjustments)}`);
        }
        if (booking.priceBreakdown.multiDayDiscount > 0) {
          doc.text(`Multi-day Discount (${booking.priceBreakdown.discountPercentage}%): ${formatCurrencyPDF(-booking.priceBreakdown.multiDayDiscount)}`);
        }
        if (booking.priceBreakdown.addonsTotal) {
          doc.text(`Add-ons: ${formatCurrencyPDF(booking.priceBreakdown.addonsTotal)}`);
        }
      } else {
        doc.text(`Base Price: ${formatCurrencyPDF(booking.priceBreakdown.basePrice || 0)}`);
        if (booking.priceBreakdown.weekdayWeekendAdjustment) {
          doc.text(`Weekend Surcharge: ${formatCurrencyPDF(booking.priceBreakdown.weekdayWeekendAdjustment)}`);
        }
        if (booking.priceBreakdown.peakSeasonAdjustment) {
          doc.text(`Peak Season Surcharge: ${formatCurrencyPDF(booking.priceBreakdown.peakSeasonAdjustment)}`);
        }
        if (booking.priceBreakdown.lastMinuteAdjustment) {
          doc.text(`Last Minute Discount: ${formatCurrencyPDF(booking.priceBreakdown.lastMinuteAdjustment)}`);
        }
        if (booking.priceBreakdown.addonsTotal) {
          doc.text(`Add-ons: ${formatCurrencyPDF(booking.priceBreakdown.addonsTotal)}`);
        }
      }
    }
    doc.moveDown();
    doc.fontSize(14).text(`Total Amount: ${formatCurrencyPDF(booking.amount || 0)}`, { align: 'right' });
    doc.moveDown();

    // Payment Status
    doc.fontSize(10);
    doc.text(`Payment Status: ${booking.paymentStatus || 'paid'}`);
    doc.text(`Booking Status: ${booking.status || 'confirmed'}`);
    doc.text(`Booked On: ${new Date(booking.bookedAt).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}`);

    // Footer
    doc.moveDown(3);
    doc.fontSize(8).text('Thank you for your booking!', { align: 'center' });

    doc.end();
  } catch (error) {
    console.error('Generate Invoice Error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Helper function for currency formatting in PDF (server-side)
function formatCurrencyPDF(amount) {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR'
  }).format(amount);
}

// =========================
// Waitlist Routes
// =========================

// Join Waitlist
app.post('/api/waitlist/join', authenticateToken, async (req, res) => {
  const { hallId, date } = req.body;

  if (!hallId || !date) {
    return res.status(422).json({ success: false, message: 'hallId and date are required' });
  }

  try {
    const normalizedDate = normalizeDateString(date);
    const hallObjectId = new ObjectId(hallId);
    const userId = new ObjectId(req.user.id);

    // Check if hall exists
    const hall = await hallsCollection.findOne({ _id: hallObjectId });
    if (!hall) {
      return res.status(404).json({ success: false, message: 'Hall not found' });
    }

    // Check if already booked by this user
    const existingBooking = await bookingsCollection.findOne({
      hallId: hallObjectId,
      date: normalizedDate,
      userId: userId,
      status: { $ne: 'cancelled' }
    });

    if (existingBooking) {
      return res.status(409).json({ success: false, message: 'You already have a booking for this date' });
    }

    // Check if already on waitlist
    const existingWaitlist = await waitlistCollection.findOne({
      hallId: hallObjectId,
      date: normalizedDate,
      userId: userId,
      status: { $in: ['pending', 'notified'] }
    });

    if (existingWaitlist) {
      return res.status(409).json({ success: false, message: 'You are already on the waitlist for this date' });
    }

    // Check if date is actually booked (only allow waitlist if fully booked)
    const isBooked = await bookingsCollection.findOne({
      hallId: hallObjectId,
      date: normalizedDate,
      status: { $ne: 'cancelled' }
    });

    if (!isBooked) {
      return res.status(422).json({ success: false, message: 'Hall is available. You can book directly.' });
    }

    // Get current waitlist position
    const waitlistCount = await waitlistCollection.countDocuments({
      hallId: hallObjectId,
      date: normalizedDate,
      status: { $in: ['pending', 'notified'] }
    });

    // Add to waitlist
    const waitlistEntry = {
      hallId: hallObjectId,
      date: normalizedDate,
      userId: userId,
      status: 'pending',
      position: waitlistCount + 1,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) // 24 hours from now
    };

    const result = await waitlistCollection.insertOne(waitlistEntry);
    waitlistEntry._id = result.insertedId;

    res.json({
      success: true,
      message: 'Added to waitlist successfully',
      waitlist: waitlistEntry
    });
  } catch (error) {
    console.error('Join Waitlist Error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Get Waitlist for User
app.get('/api/waitlist/my', authenticateToken, async (req, res) => {
  try {
    const userId = new ObjectId(req.user.id);
    const waitlistEntries = await waitlistCollection
      .find({ userId, status: { $in: ['pending', 'notified'] } })
      .sort({ createdAt: 1 })
      .toArray();

    // Attach hall details
    const waitlistWithDetails = await Promise.all(waitlistEntries.map(async (entry) => {
      const hall = await hallsCollection.findOne({ _id: entry.hallId });
      return {
        ...entry,
        hall: hall ? { name: hall.name, location: hall.location, images: hall.images } : null
      };
    }));

    res.json({ success: true, waitlist: waitlistWithDetails });
  } catch (error) {
    console.error('Get Waitlist Error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Leave Waitlist
app.post('/api/waitlist/:id/leave', authenticateToken, async (req, res) => {
  try {
    const waitlistId = new ObjectId(req.params.id);
    const waitlistEntry = await waitlistCollection.findOne({ _id: waitlistId });

    if (!waitlistEntry) {
      return res.status(404).json({ success: false, message: 'Waitlist entry not found' });
    }

    if (waitlistEntry.userId.toString() !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }

    await waitlistCollection.updateOne(
      { _id: waitlistId },
      { $set: { status: 'cancelled', cancelledAt: new Date() } }
    );

    // Recalculate positions for remaining waitlist entries
    await recalculateWaitlistPositions(waitlistEntry.hallId, waitlistEntry.date);

    res.json({ success: true, message: 'Removed from waitlist' });
  } catch (error) {
    console.error('Leave Waitlist Error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Owner: Get Waitlist for Hall/Date
app.get('/api/owner/waitlist', authenticateToken, async (req, res) => {
  if (req.user.role !== 'owner') {
    return res.status(403).json({ success: false, message: 'Unauthorized' });
  }

  try {
    const { hallId, date } = req.query;
    const ownerId = new ObjectId(req.user.id);

    let query = { status: { $in: ['pending', 'notified'] } };

    if (hallId) {
      const hallObjectId = new ObjectId(hallId);
      // Verify ownership
      const hall = await hallsCollection.findOne({ _id: hallObjectId, ownerId });
      if (!hall) {
        return res.status(403).json({ success: false, message: 'Unauthorized or hall not found' });
      }
      query.hallId = hallObjectId;
    } else {
      // Get all owner's halls
      const ownerHalls = await hallsCollection.find({ ownerId }).toArray();
      const ownerHallIds = ownerHalls.map(h => h._id);
      query.hallId = { $in: ownerHallIds };
    }

    if (date) {
      query.date = normalizeDateString(date);
    }

    const waitlistEntries = await waitlistCollection
      .find(query)
      .sort({ position: 1, createdAt: 1 })
      .toArray();

    // Attach user and hall details
    const waitlistWithDetails = await Promise.all(waitlistEntries.map(async (entry) => {
      const hall = await hallsCollection.findOne({ _id: entry.hallId });
      const user = await usersCollection.findOne({ _id: entry.userId });
      return {
        ...entry,
        hall: hall ? { name: hall.name, location: hall.location } : null,
        user: user ? { name: user.name, email: user.email, phone: user.phone } : null
      };
    }));

    res.json({ success: true, waitlist: waitlistWithDetails });
  } catch (error) {
    console.error('Get Owner Waitlist Error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Helper: Notify waitlisted users when booking is cancelled
async function notifyWaitlistedUsers(hallId, date) {
  try {
    const normalizedDate = normalizeDateString(date);

    // Get all pending waitlist entries for this hall/date, ordered by position
    const waitlistEntries = await waitlistCollection
      .find({
        hallId: hallId,
        date: normalizedDate,
        status: 'pending'
      })
      .sort({ position: 1, createdAt: 1 })
      .toArray();

    if (waitlistEntries.length === 0) {
      return;
    }

    // Get hall details
    const hall = await hallsCollection.findOne({ _id: hallId });
    if (!hall) return;

    // Notify the first user in waitlist
    const firstEntry = waitlistEntries[0];
    const user = await usersCollection.findOne({ _id: firstEntry.userId });

    if (user) {
      // Update waitlist entry status
      await waitlistCollection.updateOne(
        { _id: firstEntry._id },
        { $set: { status: 'notified', notifiedAt: new Date() } }
      );

      // Send email notification
      try {
        const htmlContent = `
          <h2>Good News! Your Waitlisted Hall is Now Available</h2>
          <p>Hello ${user.name},</p>
          <p>Great news! The hall you were waitlisted for is now available:</p>
          <ul>
            <li><strong>Hall:</strong> ${hall.name}</li>
            <li><strong>Location:</strong> ${hall.location}</li>
            <li><strong>Date:</strong> ${new Date(normalizedDate).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}</li>
          </ul>
          <p>This spot is available for the next 24 hours. Book now to secure your reservation!</p>
          <p><a href="http://localhost:3000/booking.html?hallId=${hall._id}&date=${normalizedDate}" style="background: #6366f1; color: white; padding: 12px 24px; text-decoration: none; border-radius: 8px; display: inline-block; margin-top: 1rem;">Book Now</a></p>
          <p style="color: #6b7280; font-size: 0.9rem; margin-top: 2rem;">If you don't book within 24 hours, the next person on the waitlist will be notified.</p>
        `;
        await sendBrevoEmail(user.email, `Hall Available: ${hall.name} on ${new Date(normalizedDate).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}`, htmlContent);
      } catch (emailError) {
        console.error('Error sending waitlist notification email:', emailError);
      }

      // TODO: Add SMS notification if SMS service is configured
      console.log(`Waitlist notification sent to ${user.email} for hall ${hall.name} on ${normalizedDate}`);
    }

    // Recalculate positions for remaining waitlist entries
    await recalculateWaitlistPositions(hallId, normalizedDate);
  } catch (error) {
    console.error('Error notifying waitlisted users:', error);
  }
}

// Helper: Recalculate waitlist positions
async function recalculateWaitlistPositions(hallId, date) {
  try {
    const normalizedDate = normalizeDateString(date);
    const waitlistEntries = await waitlistCollection
      .find({
        hallId: hallId,
        date: normalizedDate,
        status: { $in: ['pending', 'notified'] }
      })
      .sort({ createdAt: 1 })
      .toArray();

    // Update positions
    for (let i = 0; i < waitlistEntries.length; i++) {
      await waitlistCollection.updateOne(
        { _id: waitlistEntries[i]._id },
        { $set: { position: i + 1 } }
      );
    }
  } catch (error) {
    console.error('Error recalculating waitlist positions:', error);
  }
}

// Auto-expire waitlist entries (should be called periodically)
async function expireWaitlistEntries() {
  try {
    const now = new Date();
    const expiredEntries = await waitlistCollection.find({
      status: { $in: ['pending', 'notified'] },
      expiresAt: { $lt: now }
    }).toArray();

    for (const entry of expiredEntries) {
      await waitlistCollection.updateOne(
        { _id: entry._id },
        { $set: { status: 'expired', expiredAt: now } }
      );

      // If this was a notified entry, notify the next person
      if (entry.status === 'notified') {
        await notifyWaitlistedUsers(entry.hallId, entry.date);
      }
    }

    // Recalculate positions
    const uniqueHallDates = new Set(expiredEntries.map(e => `${e.hallId}-${e.date}`));
    for (const hallDate of uniqueHallDates) {
      const [hallId, date] = hallDate.split('-');
      await recalculateWaitlistPositions(new ObjectId(hallId), date);
    }

    console.log(`Expired ${expiredEntries.length} waitlist entries`);
  } catch (error) {
    console.error('Error expiring waitlist entries:', error);
  }
}

// Run expiration check every hour
setInterval(expireWaitlistEntries, 60 * 60 * 1000);

// Check availability for multiple halls at once (for comparison feature)
app.post('/api/bookings/check-multiple', async (req, res) => {
  const { hallIds, date } = req.body;

  if (!Array.isArray(hallIds) || !date) {
    return res.status(422).json({ success: false, message: 'hallIds array and date are required' });
  }

  try {
    const normalizedDate = normalizeDateString(date);
    const hallObjectIds = hallIds.map(id => new ObjectId(id));

    // Get all halls
    const halls = await hallsCollection.find({ _id: { $in: hallObjectIds } }).toArray();
    const hallMap = new Map(halls.map(h => [h._id.toString(), h]));

    // Get all bookings for these halls on this date
    const bookings = await bookingsCollection.find({
      hallId: { $in: hallObjectIds },
      date: normalizedDate,
      status: { $ne: 'cancelled' }
    }).toArray();

    const bookedHallIds = new Set(bookings.map(b => b.hallId.toString()));

    // Build response
    const results = hallIds.map(hallId => {
      const hall = hallMap.get(hallId);
      if (!hall) {
        return { hallId, available: false, error: 'Hall not found' };
      }

      const isBooked = bookedHallIds.has(hallId);
      const isBlocked =
        Array.isArray(hall.blockedDates) &&
        hall.blockedDates.map(normalizeDateString).includes(normalizedDate);

      return {
        hallId,
        available: !isBooked && !isBlocked,
        isBooked,
        isBlocked
      };
    });

    res.json({ success: true, results });
  } catch (error) {
    console.error('Check Multiple Bookings Error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Owner Routes
app.get('/api/owner/halls', authenticateToken, async (req, res) => {
  if (req.user.role !== 'owner') {
    return res.status(403).json({ success: false, message: 'Unauthorized' });
  }

  try {
    const ownerHalls = await hallsCollection.find({ ownerId: new ObjectId(req.user.id) }).toArray();
    res.json({ success: true, halls: ownerHalls });
  } catch (error) {
    console.error('Get Owner Halls Error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Owner: Get Pending Modification Requests
app.get('/api/owner/modification-requests', authenticateToken, async (req, res) => {
  if (req.user.role !== 'owner') {
    return res.status(403).json({ success: false, message: 'Unauthorized' });
  }

  try {
    const ownerId = new ObjectId(req.user.id);
    const ownerHalls = await hallsCollection.find({ ownerId }).toArray();
    const ownerHallIds = ownerHalls.map(h => h._id);

    // Get all bookings for owner's halls
    const bookings = await bookingsCollection.find({
      hallId: { $in: ownerHallIds }
    }).toArray();
    const bookingIds = bookings.map(b => b._id);

    // Get pending modification requests
    const modifications = await bookingModificationsCollection
      .find({
        bookingId: { $in: bookingIds },
        status: 'pending'
      })
      .sort({ requestedAt: -1 })
      .toArray();

    // Attach booking and user details
    const modificationsWithDetails = await Promise.all(modifications.map(async (mod) => {
      const booking = bookings.find(b => b._id.toString() === mod.bookingId.toString());
      const hall = booking ? await hallsCollection.findOne({ _id: booking.hallId }) : null;
      const user = booking ? await usersCollection.findOne({ _id: booking.userId }) : null;

      return {
        ...mod,
        booking: booking ? {
          ...booking,
          hall: hall ? { name: hall.name, location: hall.location } : null,
          user: user ? { name: user.name, email: user.email } : null
        } : null
      };
    }));

    res.json({ success: true, modifications: modificationsWithDetails });
  } catch (error) {
    console.error('Get Modification Requests Error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Owner Dashboard Analytics
app.get('/api/owner/analytics', authenticateToken, async (req, res) => {
  if (req.user.role !== 'owner') {
    return res.status(403).json({ success: false, message: 'Unauthorized' });
  }

  try {
    const ownerId = new ObjectId(req.user.id);
    
    // Get owner's halls
    const ownerHalls = await hallsCollection.find({ ownerId }).toArray();
    const ownerHallIds = ownerHalls.map(h => h._id);

    if (ownerHallIds.length === 0) {
      return res.json({
        success: true,
        analytics: {
          monthlyRevenue: [],
          bookingTrends: [],
          occupancyRate: {},
          popularDates: [],
          averageBookingValue: 0,
          customerDemographics: {},
          performanceMetrics: {}
        }
      });
    }

    // Get all bookings for owner's halls
    const allBookings = await bookingsCollection.find({
      hallId: { $in: ownerHallIds },
      status: { $ne: 'cancelled' }
    }).sort({ bookedAt: 1 }).toArray();

    // Get all users who booked
    const userIds = [...new Set(allBookings.map(b => b.userId.toString()))];
    const users = await usersCollection.find({
      _id: { $in: userIds.map(id => new ObjectId(id)) }
    }).toArray();

    // Calculate date ranges
    const now = new Date();
    const currentMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const previousMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const sixMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 6, 1);
    const oneYearAgo = new Date(now.getFullYear() - 1, now.getMonth(), 1);

    // Monthly Revenue (last 6 months)
    const monthlyRevenue = [];
    for (let i = 5; i >= 0; i--) {
      const monthStart = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const monthEnd = new Date(now.getFullYear(), now.getMonth() - i + 1, 0, 23, 59, 59);
      
      const monthBookings = allBookings.filter(b => {
        const bookedDate = new Date(b.bookedAt);
        return bookedDate >= monthStart && bookedDate <= monthEnd;
      });
      
      const revenue = monthBookings.reduce((sum, b) => sum + (b.amount || 0), 0);
      monthlyRevenue.push({
        month: monthStart.toLocaleString('default', { month: 'short', year: 'numeric' }),
        revenue: revenue,
        bookings: monthBookings.length
      });
    }

    // Booking Trends (last 12 months)
    const bookingTrends = [];
    for (let i = 11; i >= 0; i--) {
      const monthStart = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const monthEnd = new Date(now.getFullYear(), now.getMonth() - i + 1, 0, 23, 59, 59);
      
      const monthBookings = allBookings.filter(b => {
        const bookedDate = new Date(b.bookedAt);
        return bookedDate >= monthStart && bookedDate <= monthEnd;
      });
      
      bookingTrends.push({
        month: monthStart.toLocaleString('default', { month: 'short' }),
        count: monthBookings.length
      });
    }

    // Occupancy Rate (last 90 days calendar heatmap data)
    const occupancyRate = {};
    const ninetyDaysAgo = new Date(now);
    ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);

    // Get all bookings in date range
    const recentBookings = allBookings.filter(b => {
      const bookingDate = new Date(b.date);
      return bookingDate >= ninetyDaysAgo && bookingDate <= now;
    });

    // Count bookings per date
    recentBookings.forEach(b => {
      const dateStr = normalizeDateString(b.date);
      occupancyRate[dateStr] = (occupancyRate[dateStr] || 0) + 1;
    });

    // Popular Dates (top 10 most booked dates)
    const dateCounts = {};
    allBookings.forEach(b => {
      const dateStr = normalizeDateString(b.date);
      dateCounts[dateStr] = (dateCounts[dateStr] || 0) + 1;
    });

    const popularDates = Object.entries(dateCounts)
      .map(([date, count]) => ({ date, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10)
      .map(item => ({
        date: item.date,
        count: item.count,
        formattedDate: new Date(item.date).toLocaleDateString('en-US', {
          year: 'numeric',
          month: 'long',
          day: 'numeric'
        })
      }));

    // Average Booking Value
    const totalRevenue = allBookings.reduce((sum, b) => sum + (b.amount || 0), 0);
    const averageBookingValue = allBookings.length > 0 ? totalRevenue / allBookings.length : 0;

    // Customer Demographics
    const customerDemographics = {
      totalCustomers: userIds.length,
      repeatCustomers: 0,
      newCustomers: 0,
      byLocation: {},
      byEventType: {}
    };

    // Count repeat vs new customers
    const customerBookingCounts = {};
    allBookings.forEach(b => {
      const userId = b.userId.toString();
      customerBookingCounts[userId] = (customerBookingCounts[userId] || 0) + 1;
    });

    Object.values(customerBookingCounts).forEach(count => {
      if (count > 1) {
        customerDemographics.repeatCustomers++;
      } else {
        customerDemographics.newCustomers++;
      }
    });

    // Event type distribution
    allBookings.forEach(b => {
      const eventType = b.eventType || 'Not Specified';
      customerDemographics.byEventType[eventType] = (customerDemographics.byEventType[eventType] || 0) + 1;
    });

    // Performance Metrics (current month vs previous month)
    const currentMonthBookings = allBookings.filter(b => {
      const bookedDate = new Date(b.bookedAt);
      return bookedDate >= currentMonth && bookedDate <= now;
    });

    const previousMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59);
    const previousMonthBookings = allBookings.filter(b => {
      const bookedDate = new Date(b.bookedAt);
      return bookedDate >= previousMonth && bookedDate <= previousMonthEnd;
    });

    const currentMonthRevenue = currentMonthBookings.reduce((sum, b) => sum + (b.amount || 0), 0);
    const previousMonthRevenue = previousMonthBookings.reduce((sum, b) => sum + (b.amount || 0), 0);

    const revenueChange = previousMonthRevenue > 0 
      ? ((currentMonthRevenue - previousMonthRevenue) / previousMonthRevenue) * 100 
      : 0;

    const bookingsChange = previousMonthBookings.length > 0
      ? ((currentMonthBookings.length - previousMonthBookings.length) / previousMonthBookings.length) * 100
      : 0;

    const performanceMetrics = {
      currentMonth: {
        revenue: currentMonthRevenue,
        bookings: currentMonthBookings.length,
        averageBookingValue: currentMonthBookings.length > 0 ? currentMonthRevenue / currentMonthBookings.length : 0
      },
      previousMonth: {
        revenue: previousMonthRevenue,
        bookings: previousMonthBookings.length,
        averageBookingValue: previousMonthBookings.length > 0 ? previousMonthRevenue / previousMonthBookings.length : 0
      },
      changes: {
        revenueChange: Math.round(revenueChange * 100) / 100,
        bookingsChange: Math.round(bookingsChange * 100) / 100
      }
    };

    res.json({
      success: true,
      analytics: {
        monthlyRevenue,
        bookingTrends,
        occupancyRate,
        popularDates,
        averageBookingValue,
        customerDemographics,
        performanceMetrics
      }
    });
  } catch (error) {
    console.error('Get Owner Analytics Error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Admin Routes
app.get('/api/admin/stats', authenticateToken, async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ success: false, message: 'Unauthorized' });
  }

  try {
    const totalUsers = await usersCollection.countDocuments({ role: 'user' });
    const totalOwners = await usersCollection.countDocuments({ role: 'owner' });
    const totalHalls = await hallsCollection.countDocuments({});
    const approvedHalls = await hallsCollection.countDocuments({ status: 'approved' });
    const pendingHalls = await hallsCollection.countDocuments({ status: 'pending' });
    const totalBookings = await bookingsCollection.countDocuments({});
    const bookingData = await bookingsCollection.find({}).toArray();
    const totalRevenue = bookingData.reduce((sum, b) => sum + (b.amount || 0), 0);

    const stats = {
      totalUsers,
      totalOwners,
      totalHalls,
      approvedHalls,
      pendingHalls,
      totalBookings,
      totalRevenue
    };

    res.json({ success: true, stats });
  } catch (error) {
    console.error('Get Stats Error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

app.get('/api/admin/users', authenticateToken, async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ success: false, message: 'Unauthorized' });
  }

  try {
    const allUsers = await usersCollection.find({}).toArray();
    const safeUsers = allUsers.map(u => ({ ...u, password: undefined }));
    res.json({ success: true, users: safeUsers });
  } catch (error) {
    console.error('Get Users Error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

app.get('/api/admin/halls', authenticateToken, async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ success: false, message: 'Unauthorized' });
  }

  try {
    const allHalls = await hallsCollection.find({}).toArray();
    res.json({ success: true, halls: allHalls });
  } catch (error) {
    console.error('Get Admin Halls Error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

app.put('/api/admin/halls/:id/approve', authenticateToken, async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ success: false, message: 'Unauthorized' });
  }

  try {
    const result = await hallsCollection.updateOne(
      { _id: new ObjectId(req.params.id) },
      { $set: { status: 'approved' } }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({ success: false, message: 'Hall not found' });
    }

    const hall = await hallsCollection.findOne({ _id: new ObjectId(req.params.id) });
    res.json({ success: true, hall });
  } catch (error) {
    console.error('Approve Hall Error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// =========================
// Recommendation Routes
// =========================

// Modular scoring function for hall recommendations (ready for future AI/ML replacement)
function scoreHallForRecommendation(hall, criteria) {
  let score = 0;

  const price = hall.price || 0;
  const capacity = hall.capacity || 0;

  // Budget factor: reward halls within or slightly above budget
  if (criteria.budget) {
    const budget = criteria.budget;
    if (price <= budget) {
      score += 30; // within budget
      const diff = budget - price;
      score += Math.min(20, Math.max(0, diff / budget * 20)); // cheaper gets small extra
    } else if (price <= budget * 1.3) {
      score += 10; // slightly above budget but still acceptable
    } else {
      score -= 10; // too expensive
    }
  }

  // Capacity vs guest count
  if (criteria.guestCount) {
    const guests = criteria.guestCount;
    if (capacity >= guests) {
      score += 25;
      const extra = capacity - guests;
      if (extra < guests * 0.2) {
        score += 10; // close match
      }
    } else {
      score -= 20; // not enough capacity
    }
  }

  // Event type vs category
  if (criteria.eventType && hall.category) {
    const ev = criteria.eventType.toLowerCase();
    const cat = hall.category.toLowerCase();
    if (cat.includes(ev) || ev.includes(cat)) {
      score += 25;
    }
  }

  // Location (text match)
  if (criteria.location && hall.location) {
    const loc = criteria.location.toLowerCase();
    const hallLoc = hall.location.toLowerCase();
    if (hallLoc.includes(loc)) {
      score += 20;
    }
  }

  // Location (distance) if coords are available
  if (
    criteria.lat != null &&
    criteria.lng != null &&
    hall.lat != null &&
    hall.lng != null
  ) {
    const dist = calculateDistance(
      criteria.lat,
      criteria.lng,
      hall.lat,
      hall.lng
    );
    // Reward closer halls; clamp to reasonable range
    if (!isNaN(dist)) {
      const distanceScore = Math.max(0, 30 - dist); // up to 30 points, decreasing with distance
      score += distanceScore;
    }
  }

  return score;
}

app.post('/api/halls/recommend', async (req, res) => {
  const { budget, eventType, location, guestCount, lat, lng } = req.body || {};

  try {
    const halls = await hallsCollection.find({ status: 'approved' }).toArray();
    const criteria = {
      budget: budget ? parseInt(budget) : null,
      eventType: eventType || '',
      location: location || '',
      guestCount: guestCount ? parseInt(guestCount) : null,
      lat: typeof lat === 'number' ? lat : lat ? parseFloat(lat) : null,
      lng: typeof lng === 'number' ? lng : lng ? parseFloat(lng) : null
    };

    const scored = halls.map(hall => ({
      ...hall,
      score: scoreHallForRecommendation(hall, criteria)
    }));

    scored.sort((a, b) => b.score - a.score);

    res.json({
      success: true,
      halls: scored
        .filter(h => h.score > 0) // Only return relevant halls
        .slice(0, 10)
        .map(h => ({
          ...h,
          blockedDates: h.blockedDates || [],
          addons: h.addons || []
        }))
    });
  } catch (error) {
    console.error('Recommend Halls Error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

app.get('/api/admin/bookings', authenticateToken, async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ success: false, message: 'Unauthorized' });
  }

  try {
    const allBookings = await bookingsCollection.find({}).toArray();

    const bookingsWithDetails = await Promise.all(allBookings.map(async (b) => {
      const hall = await hallsCollection.findOne({ _id: b.hallId });
      const user = await usersCollection.findOne({ _id: b.userId });
      return {
        ...b,
        hall: hall ? { name: hall.name, location: hall.location } : null,
        user: user ? { name: user.name, email: user.email } : null
      };
    }));

    res.json({ success: true, bookings: bookingsWithDetails });
  } catch (error) {
    console.error('Get Admin Bookings Error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Start Server
async function start() {
  try {
    await connectDB();
    await removeDuplicateHalls();
    await updateAllPricesToOne();
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`🚀 Event Hall Booking System running on port ${PORT}`);
      console.log(`📂 Open your app in your browser`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

// Razorpay Order Route
app.post('/api/create-razorpay-order', authenticateToken, async (req, res) => {
  const { hallId, amount } = req.body;

  try {
    const options = {
      amount: amount * 100, // amount in the smallest currency unit
      currency: "INR",
      receipt: `rcpt_${Date.now()}`
    };
    const order = await razorpay.orders.create(options);
    res.json({ success: true, order, keyId: process.env.RAZORPAY_KEY_ID });
  } catch (error) {
    console.error('Razorpay Order Error:', error);
    res.status(500).json({ success: false, message: 'Failed to create payment order' });
  }
});

start();
