const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const db = require('../config/database');
const { auth, requireVerified, checkUserPermissions } = require('../middleware/auth');
const emailService = require('../services/emailService');

const router = express.Router();

// Validation pour l'inscription
const registerValidation = [
  body('email')
    .isEmail()
    .normalizeEmail()
    .withMessage('Veuillez fournir une adresse email valide'),
  body('password')
    .isLength({ min: 6 })
    .withMessage('Le mot de passe doit contenir au moins 6 caractères'),
  body('firstName')
    .trim()
    .isLength({ min: 2 })
    .withMessage('Le prénom doit contenir au moins 2 caractères'),
  body('lastName')
    .trim()
    .isLength({ min: 2 })
    .withMessage('Le nom doit contenir au moins 2 caractères'),
  body('userType')
    .isIn(['traveler', 'sender', 'both'])
    .withMessage('Type d\'utilisateur invalide')
];

// Validation pour la connexion
const loginValidation = [
  body('email')
    .isEmail()
    .normalizeEmail()
    .withMessage('Veuillez fournir une adresse email valide'),
  body('password')
    .notEmpty()
    .withMessage('Le mot de passe est requis')
];

// Route d'inscription
router.post('/register', registerValidation, async (req, res) => {
  try {
    // Vérification des erreurs de validation
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        error: 'Données invalides',
        details: errors.array()
      });
    }

    const { email, password, firstName, lastName, phone, userType } = req.body;

    // Vérifier si l'utilisateur existe déjà
    const existingUser = await db.query(
      'SELECT id FROM users WHERE email = $1',
      [email]
    );

    if (existingUser.rows.length > 0) {
      return res.status(400).json({
        error: 'Un compte avec cette adresse email existe déjà'
      });
    }

    // Hacher le mot de passe
    const saltRounds = 12;
    const passwordHash = await bcrypt.hash(password, saltRounds);

    // Créer l'utilisateur
    const result = await db.query(
      `INSERT INTO users (email, password_hash, first_name, last_name, phone, user_type)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, email, first_name, last_name, phone, user_type, is_verified, created_at`,
      [email, passwordHash, firstName, lastName, phone, userType]
    );

    const user = result.rows[0];

    // Générer et envoyer l'email de vérification
    try {
      const verificationToken = emailService.generateVerificationToken();
      await emailService.storeVerificationToken(user.id, verificationToken, 'email_verification');
      await emailService.sendVerificationEmail(user.email, user.first_name, verificationToken);
      
      console.log(`📧 Email de vérification envoyé à ${user.email}`);
    } catch (emailError) {
      console.error('⚠️ Erreur envoi email de vérification:', emailError.message);
      // Ne pas faire échouer l'inscription si l'email ne peut pas être envoyé
    }

    // Générer un token JWT
    const token = jwt.sign(
      { userId: user.id, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );

    res.status(201).json({
      message: 'Compte créé avec succès. Un email de vérification a été envoyé.',
      user: {
        id: user.id,
        email: user.email,
        firstName: user.first_name,
        lastName: user.last_name,
        phone: user.phone,
        userType: user.user_type,
        isVerified: user.is_verified,
        createdAt: user.created_at
      },
      token,
      emailSent: true
    });

  } catch (error) {
    console.error('Erreur lors de l\'inscription:', error);
    res.status(500).json({
      error: 'Erreur interne du serveur lors de l\'inscription'
    });
  }
});

// Route de connexion
router.post('/login', loginValidation, async (req, res) => {
  try {
    // Vérification des erreurs de validation
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        error: 'Données invalides',
        details: errors.array()
      });
    }

    const { email, password } = req.body;

    // Trouver l'utilisateur
    const result = await db.query(
      'SELECT id, email, password_hash, first_name, last_name, phone, user_type, is_verified, rating FROM users WHERE email = $1',
      [email]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({
        error: 'Email ou mot de passe incorrect'
      });
    }

    const user = result.rows[0];

    // Vérifier le mot de passe
    const isPasswordValid = await bcrypt.compare(password, user.password_hash);
    if (!isPasswordValid) {
      return res.status(401).json({
        error: 'Email ou mot de passe incorrect'
      });
    }

    // Générer un token JWT
    const token = jwt.sign(
      { userId: user.id, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );

    res.json({
      message: 'Connexion réussie',
      user: {
        id: user.id,
        email: user.email,
        firstName: user.first_name,
        lastName: user.last_name,
        phone: user.phone,
        userType: user.user_type,
        isVerified: user.is_verified,
        rating: parseFloat(user.rating)
      },
      token
    });

  } catch (error) {
    console.error('Erreur lors de la connexion:', error);
    res.status(500).json({
      error: 'Erreur interne du serveur lors de la connexion'
    });
  }
});

// Route pour vérifier le token
router.get('/verify', auth, async (req, res) => {
  try {
    const result = await db.query(
      'SELECT id, email, first_name, last_name, phone, user_type, is_verified, rating FROM users WHERE id = $1',
      [req.user.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: 'Utilisateur non trouvé'
      });
    }

    const user = result.rows[0];

    // Vérifier les documents approuvés
    const docsResult = await db.query(
      'SELECT COUNT(*) as approved_count FROM user_documents WHERE user_id = $1 AND verification_status = $2',
      [req.user.userId, 'approved']
    );

    const hasApprovedDocuments = parseInt(docsResult.rows[0].approved_count) > 0;

    // Calculer les permissions
    const permissions = checkUserPermissions(user);
    permissions.hasDocuments = hasApprovedDocuments;

    res.json({
      user: {
        id: user.id,
        email: user.email,
        firstName: user.first_name,
        lastName: user.last_name,
        phone: user.phone,
        userType: user.user_type,
        isVerified: user.is_verified,
        rating: parseFloat(user.rating),
        hasApprovedDocuments
      },
      permissions
    });

  } catch (error) {
    console.error('Erreur lors de la vérification du token:', error);
    res.status(500).json({
      error: 'Erreur interne du serveur'
    });
  }
});

// Route pour obtenir les permissions détaillées de l'utilisateur
router.get('/permissions', auth, async (req, res) => {
  try {
    // Récupérer les infos utilisateur
    const userResult = await db.query(
      'SELECT id, email, first_name, last_name, user_type, is_verified FROM users WHERE id = $1',
      [req.user.userId]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({
        error: 'Utilisateur non trouvé'
      });
    }

    const user = userResult.rows[0];

    // Vérifier les documents
    const docsResult = await db.query(
      'SELECT COUNT(*) as approved_count, COUNT(*) as total_count FROM user_documents WHERE user_id = $1',
      [req.user.userId]
    );

    const hasApprovedDocuments = parseInt(docsResult.rows[0].approved_count) > 0;
    const totalDocuments = parseInt(docsResult.rows[0].total_count);

    // Calculer les permissions pour différents scénarios
    const permissions = {
      current: checkUserPermissions(user),
      withVerification: checkUserPermissions(user, null, true),
      withDocuments: checkUserPermissions(user, null, false, true),
      full: checkUserPermissions(user, null, true, true)
    };

    // Mettre à jour le statut des documents
    Object.keys(permissions).forEach(key => {
      permissions[key].hasDocuments = hasApprovedDocuments;
    });

    res.json({
      user: {
        id: user.id,
        email: user.email,
        firstName: user.first_name,
        lastName: user.last_name,
        userType: user.user_type,
        isVerified: user.is_verified,
        hasApprovedDocuments,
        totalDocuments
      },
      permissions,
      recommendations: {
        verifyEmail: !user.is_verified,
        uploadDocuments: !hasApprovedDocuments,
        completeProfile: !user.first_name || !user.last_name
      }
    });
  } catch (error) {
    console.error('Erreur récupération permissions:', error);
    res.status(500).json({
      error: 'Erreur serveur lors de la récupération des permissions'
    });
  }
});

//// Route de déconnexion
router.post('/logout', auth, (req, res) => {
  res.json({
    message: 'Déconnexion réussie'
  });
});

// Route pour vérifier l'email
router.post('/verify-email', async (req, res) => {
  try {
    const { token } = req.body;
    
    if (!token) {
      return res.status(400).json({
        error: 'Token de vérification requis'
      });
    }
    
    // Vérifier le token
    const verification = await emailService.verifyToken(token, 'email_verification');
    
    if (!verification.valid) {
      return res.status(400).json({
        error: verification.error
      });
    }
    
    // Marquer l'utilisateur comme vérifié
    await db.query(
      'UPDATE users SET is_verified = true WHERE id = $1',
      [verification.user.user_id]
    );
    
    // Supprimer le token utilisé
    await emailService.deleteToken(token, 'email_verification');
    
    res.json({
      message: 'Email vérifié avec succès',
      verified: true
    });
    
  } catch (error) {
    console.error('Erreur lors de la vérification email:', error);
    res.status(500).json({
      error: 'Erreur interne du serveur lors de la vérification'
    });
  }
});

// Route pour renvoyer l'email de vérification
router.post('/resend-verification', auth, async (req, res) => {
  try {
    // Récupérer les infos de l'utilisateur
    const result = await db.query(
      'SELECT email, first_name, is_verified FROM users WHERE id = $1',
      [req.user.userId]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({
        error: 'Utilisateur non trouvé'
      });
    }
    
    const user = result.rows[0];
    
    if (user.is_verified) {
      return res.status(400).json({
        error: 'Email déjà vérifié'
      });
    }
    
    // Générer et envoyer un nouveau token
    const verificationToken = emailService.generateVerificationToken();
    await emailService.storeVerificationToken(req.user.userId, verificationToken, 'email_verification');
    await emailService.sendVerificationEmail(user.email, user.first_name, verificationToken);
    
    res.json({
      message: 'Email de vérification renvoyé avec succès'
    });
    
  } catch (error) {
    console.error('Erreur lors du renvoi de vérification:', error);
    res.status(500).json({
      error: 'Erreur interne du serveur lors du renvoi'
    });
  }
});

// Route pour demander la récupération de mot de passe
router.post('/forgot-password', [
  body('email')
    .isEmail()
    .normalizeEmail()
    .withMessage('Veuillez fournir une adresse email valide')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        error: 'Données invalides',
        details: errors.array()
      });
    }
    
    const { email } = req.body;
    
    // Vérifier si l'utilisateur existe
    const result = await db.query(
      'SELECT id, first_name FROM users WHERE email = $1',
      [email]
    );
    
    // Toujours renvoyer un message de succès pour des raisons de sécurité
    // (ne pas révéler si l'email existe ou non)
    if (result.rows.length === 0) {
      return res.json({
        message: 'Si cet email existe, un lien de récupération a été envoyé'
      });
    }
    
    const user = result.rows[0];
    
    // Générer et envoyer l'email de récupération
    const resetToken = emailService.generateVerificationToken();
    await emailService.storeVerificationToken(user.id, resetToken, 'password_reset');
    await emailService.sendPasswordResetEmail(email, user.first_name, resetToken);
    
    res.json({
      message: 'Si cet email existe, un lien de récupération a été envoyé'
    });
    
  } catch (error) {
    console.error('Erreur lors de la demande de récupération:', error);
    res.status(500).json({
      error: 'Erreur interne du serveur lors de la demande'
    });
  }
});

// Route pour réinitialiser le mot de passe
router.post('/reset-password', [
  body('token')
    .notEmpty()
    .withMessage('Token de récupération requis'),
  body('newPassword')
    .isLength({ min: 6 })
    .withMessage('Le nouveau mot de passe doit contenir au moins 6 caractères')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        error: 'Données invalides',
        details: errors.array()
      });
    }
    
    const { token, newPassword } = req.body;
    
    // Vérifier le token
    const verification = await emailService.verifyToken(token, 'password_reset');
    
    if (!verification.valid) {
      return res.status(400).json({
        error: verification.error
      });
    }
    
    // Hacher le nouveau mot de passe
    const saltRounds = 12;
    const hashedPassword = await bcrypt.hash(newPassword, saltRounds);
    
    // Mettre à jour le mot de passe
    await db.query(
      'UPDATE users SET password_hash = $1 WHERE id = $2',
      [hashedPassword, verification.user.user_id]
    );
    
    // Supprimer le token utilisé
    await emailService.deleteToken(token, 'password_reset');
    
    res.json({
      message: 'Mot de passe réinitialisé avec succès'
    });
    
  } catch (error) {
    console.error('Erreur lors de la réinitialisation:', error);
    res.status(500).json({
      error: 'Erreur interne du serveur lors de la réinitialisation'
    });
  }
});

// Route pour changer le type d'utilisateur
router.put('/change-user-type', auth, requireVerified, async (req, res) => {
  try {
    const { userType } = req.body;

    // Valider le type d'utilisateur
    const validTypes = ['sender', 'traveler', 'both'];
    if (!validTypes.includes(userType)) {
      return res.status(400).json({
        error: 'Type d\'utilisateur invalide',
        validTypes
      });
    }

    // Mettre à jour le type d'utilisateur
    const result = await db.query(
      'UPDATE users SET user_type = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING id, email, first_name, last_name, user_type, is_verified',
      [userType, req.user.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: 'Utilisateur non trouvé'
      });
    }

    const user = result.rows[0];

    // Calculer les nouvelles permissions
    const permissions = checkUserPermissions(user);

    res.json({
      message: 'Type d\'utilisateur mis à jour avec succès',
      user,
      permissions
    });
  } catch (error) {
    console.error('Erreur changement type utilisateur:', error);
    res.status(500).json({
      error: 'Erreur serveur lors du changement de type'
    });
  }
});

module.exports = router;