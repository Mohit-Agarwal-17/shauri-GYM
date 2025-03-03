const express = require('express');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const bodyParser = require('body-parser');
const bcrypt = require('bcrypt');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { connectToMongoDB, User, UserProfile } = require('./database');
require('dotenv').config();

// Initialize express app
const app = express();
const PORT = process.env.PORT || 3000;

// Initialize Google Gemini API
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || 'YOUR_API_KEY_HERE');

// Connect to MongoDB
connectToMongoDB();

// Middleware
app.use(express.static(path.join(__dirname, 'public')));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

// Session configuration with MongoDB store
app.use(session({
  secret: process.env.SESSION_SECRET || 'secret_key',
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({
    mongoUrl: process.env.MONGODB_URI || 'mongodb+srv://username:password@cluster0.mongodb.net/gym_db?retryWrites=true&w=majority',
    ttl: 14 * 24 * 60 * 60, // 14 days
    autoRemove: 'native'
  }),
  cookie: { 
    secure: process.env.NODE_ENV === 'production',
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
  }
}));

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
    
    // Check if user already exists
    const existingUser = await User.findOne({ 
      $or: [{ username }, { email }] 
    });
    
    if (existingUser) {
      return res.status(400).json({ 
        message: 'Username or email already exists' 
      });
    }
    
    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);
    
    // Create new user
    const newUser = new User({
      username,
      email,
      password: hashedPassword
    });
    
    await newUser.save();
    
    res.status(201).json({ 
      message: 'User created successfully', 
      userId: newUser._id 
    });
  } catch (error) {
    console.error('Signup error:', error);
    res.status(500).json({ 
      message: 'Signup failed', 
      error: error.message 
    });
  }
});

// User login
app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    
    // Find user in database
    const user = await User.findOne({ username });
    
    if (!user) {
      return res.status(401).json({ message: 'Invalid username or password' });
    }
    
    // Compare password
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).json({ message: 'Invalid username or password' });
    }
    
    // Set user session
    req.session.userId = user._id;
    req.session.username = user.username;
    
    // Check if profile exists
    const profile = await UserProfile.findOne({ user_id: user._id });
    
    res.status(200).json({ 
      message: 'Login successful',
      hasProfile: !!profile
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ 
      message: 'Login failed', 
      error: error.message 
    });
  }
});

// Save user profile
app.post('/api/profile', isAuthenticated, async (req, res) => {
  try {
    const { name, age, weight, dietaryPreference, targetBodyType } = req.body;
    const userId = req.session.userId;
    
    // Check if profile already exists
    let profile = await UserProfile.findOne({ user_id: userId });
    
    if (profile) {
      // Update existing profile
      profile.name = name;
      profile.age = age;
      profile.weight = weight;
      profile.dietary_preference = dietaryPreference;
      profile.target_body_type = targetBodyType;
      profile.updated_at = new Date();
    } else {
      // Create new profile
      profile = new UserProfile({
        user_id: userId,
        name,
        age,
        weight,
        dietary_preference: dietaryPreference,
        target_body_type: targetBodyType
      });
    }
    
    // Generate workout plan with Google Gemini
    const workoutPlan = await generateWorkoutPlan({
      name, age, weight, dietaryPreference, targetBodyType
    });
    
    // Save workout plan
    profile.workout_plan = workoutPlan;
    await profile.save();
    
    res.status(200).json({ 
      message: 'Profile saved successfully',
      workoutPlan: workoutPlan
    });
  } catch (error) {
    console.error('Profile save error:', error);
    res.status(500).json({ 
      message: 'Failed to save profile', 
      error: error.message 
    });
  }
});

// Get user profile and workout plan
app.get('/api/profile', isAuthenticated, async (req, res) => {
  try {
    const profile = await UserProfile.findOne({ user_id: req.session.userId });
    
    if (!profile) {
      return res.status(404).json({ message: 'Profile not found' });
    }
    
    res.status(200).json({ profile });
  } catch (error) {
    console.error('Get profile error:', error);
    res.status(500).json({ 
      message: 'Failed to get profile', 
      error: error.message 
    });
  }
});

// Logout
app.get('/api/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      return res.status(500).json({ message: 'Logout failed' });
    }
    res.status(200).json({ message: 'Logged out successfully' });
  });
});

// Helper function to generate workout plan using Google Gemini
async function generateWorkoutPlan(userProfile) {
  try {
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-pro" });
    
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