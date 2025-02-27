const express = require('express');
const session = require('express-session');
const bodyParser = require('body-parser');
const bcrypt = require('bcrypt');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { pool, initDb } = require('./database');

// Initialize express app
const app = express();
const PORT = process.env.PORT || 3000;

// Initialize Google Gemini API
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || 'YOUR_API_KEY_HERE');

// Middleware
app.use(express.static(path.join(__dirname, 'public')));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(session({
  secret: process.env.SESSION_SECRET || 'secret_key',
  resave: false,
  saveUninitialized: true,
  cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 } // 24 hours
}));

// Initialize database
initDb();

// Middleware to check if user is logged in
const isAuthenticated = (req, res, next) => {
  if (req.session.userId) {
    return next();
  }
  res.redirect('/login.html');
};

// Routes
app.get('/', (req, res) => {
  res.redirect('/login.html');
});

// User registration
app.post('/api/signup', async (req, res) => {
  try {
    const { username, email, password } = req.body;
    
    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);
    
    // Insert user into database
    const [result] = await pool.execute(
      'INSERT INTO users (username, email, password) VALUES (?, ?, ?)',
      [username, email, hashedPassword]
    );
    
    res.status(201).json({ message: 'User created successfully', userId: result.insertId });
  } catch (error) {
    console.error('Signup error:', error);
    res.status(500).json({ message: 'Signup failed', error: error.message });
  }
});

// User login
app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    
    // Find user in database
    const [users] = await pool.execute(
      'SELECT * FROM users WHERE username = ?',
      [username]
    );
    
    if (users.length === 0) {
      return res.status(401).json({ message: 'Invalid username or password' });
    }
    
    const user = users[0];
    
    // Compare password
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).json({ message: 'Invalid username or password' });
    }
    
    // Set user session
    req.session.userId = user.id;
    req.session.username = user.username;
    
    // Check if profile exists
    const [profiles] = await pool.execute(
      'SELECT * FROM user_profiles WHERE user_id = ?',
      [user.id]
    );
    
    const hasProfile = profiles.length > 0;
    
    res.status(200).json({ 
      message: 'Login successful',
      hasProfile: hasProfile
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ message: 'Login failed', error: error.message });
  }
});

// Save user profile
app.post('/api/profile', isAuthenticated, async (req, res) => {
  try {
    const { name, age, weight, dietaryPreference, targetBodyType } = req.body;
    const userId = req.session.userId;
    
    // Check if profile already exists
    const [existingProfiles] = await pool.execute(
      'SELECT * FROM user_profiles WHERE user_id = ?',
      [userId]
    );
    
    if (existingProfiles.length > 0) {
      // Update existing profile
      await pool.execute(
        `UPDATE user_profiles 
         SET name = ?, age = ?, weight = ?, dietary_preference = ?, target_body_type = ?
         WHERE user_id = ?`,
        [name, age, weight, dietaryPreference, targetBodyType, userId]
      );
    } else {
      // Create new profile
      await pool.execute(
        `INSERT INTO user_profiles 
         (user_id, name, age, weight, dietary_preference, target_body_type)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [userId, name, age, weight, dietaryPreference, targetBodyType]
      );
    }
    
    // Generate workout plan with Google Gemini
    const workoutPlan = await generateWorkoutPlan({
      name, age, weight, dietaryPreference, targetBodyType
    });
    
    // Save workout plan
    await pool.execute(
      'UPDATE user_profiles SET workout_plan = ? WHERE user_id = ?',
      [workoutPlan, userId]
    );
    
    res.status(200).json({ 
      message: 'Profile saved successfully',
      workoutPlan: workoutPlan
    });
  } catch (error) {
    console.error('Profile save error:', error);
    res.status(500).json({ message: 'Failed to save profile', error: error.message });
  }
});

// Get user profile and workout plan
app.get('/api/profile', isAuthenticated, async (req, res) => {
  try {
    const [profiles] = await pool.execute(
      'SELECT * FROM user_profiles WHERE user_id = ?',
      [req.session.userId]
    );
    
    if (profiles.length === 0) {
      return res.status(404).json({ message: 'Profile not found' });
    }
    
    res.status(200).json({ profile: profiles[0] });
  } catch (error) {
    console.error('Get profile error:', error);
    res.status(500).json({ message: 'Failed to get profile', error: error.message });
  }
});

// Logout
app.get('/api/logout', (req, res) => {
  req.session.destroy();
  res.status(200).json({ message: 'Logged out successfully' });
});

// Helper function to generate workout plan using Google Gemini
async function generateWorkoutPlan(userProfile) {
  try {
    const model = genAI.getGenerativeModel({ model: "gemini-pro" });
    
    const prompt = `
    Create a personalized 7-day workout plan for a person with the following details:
    - Name: ${userProfile.name}
    - Age: ${userProfile.age}
    - Weight: ${userProfile.weight} kg
    - Dietary Preference: ${userProfile.dietaryPreference}
    - Target Body Type: ${userProfile.targetBodyType}
    
    Include specific exercises, sets, reps, and rest periods. Also include dietary suggestions based on their preference.
    Format the response in an easy-to-read structure.
    `;
    
    const result = await model.generateContent(prompt);
    const response = await result.response;
    return response.text();
  } catch (error) {
    console.error('Workout plan generation error:', error);
    return "Unable to generate workout plan at the moment. Please try again later.";
  }
}

// Start the server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
