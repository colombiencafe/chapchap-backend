const jwt = require('jsonwebtoken');
const db = require('../config/database');

// Middleware d'authentification
const auth = async (req, res, next) => {
  try {
    // Récupérer le token depuis l'en-tête Authorization
    const authHeader = req.header('Authorization');
    
    if (!authHeader) {
      return res.status(401).json({
        error: 'Accès refusé. Token d\'authentification manquant.'
      });
    }

    // Vérifier le format du token (Bearer token)
    const token = authHeader.startsWith('Bearer ') 
      ? authHeader.slice(7) 
      : authHeader;

    if (!token) {
      return res.status(401).json({
        error: 'Accès refusé. Format de token invalide.'
      });
    }

    // Vérifier et décoder le token
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
    // Vérifier que l'utilisateur existe toujours dans la base de données
    const result = await db.query(
      'SELECT id, email, first_name, last_name, user_type, is_verified FROM users WHERE id = $1',
      [decoded.userId]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({
        error: 'Token invalide. Utilisateur non trouvé.'
      });
    }

    // Ajouter les informations de l'utilisateur à la requête
    req.user = {
      userId: decoded.userId,
      email: decoded.email,
      ...result.rows[0]
    };

    next();

  } catch (error) {
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({
        error: 'Token invalide.'
      });
    }
    
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({
        error: 'Token expiré. Veuillez vous reconnecter.'
      });
    }

    console.error('Erreur dans le middleware d\'authentification:', error);
    res.status(500).json({
      error: 'Erreur interne du serveur lors de l\'authentification'
    });
  }
};

// Middleware optionnel d'authentification (n'échoue pas si pas de token)
const optionalAuth = async (req, res, next) => {
  try {
    const authHeader = req.header('Authorization');
    
    if (!authHeader) {
      return next();
    }

    const token = authHeader.startsWith('Bearer ') 
      ? authHeader.slice(7) 
      : authHeader;

    if (!token) {
      return next();
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
    const result = await db.query(
      'SELECT id, email, first_name, last_name, user_type, is_verified FROM users WHERE id = $1',
      [decoded.userId]
    );

    if (result.rows.length > 0) {
      req.user = {
        userId: decoded.userId,
        email: decoded.email,
        ...result.rows[0]
      };
    }

    next();

  } catch (error) {
    // En cas d'erreur, on continue sans utilisateur authentifié
    next();
  }
};

// Middleware pour vérifier le type d'utilisateur
const requireUserType = (allowedTypes) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        error: 'Authentification requise'
      });
    }

    const userType = req.user.user_type;
    
    // Si l'utilisateur est de type 'both', il a accès à tout
    if (userType === 'both') {
      return next();
    }

    // Vérifier si le type d'utilisateur est autorisé
    if (!allowedTypes.includes(userType)) {
      return res.status(403).json({
        error: `Accès refusé. Cette action nécessite un compte de type: ${allowedTypes.join(' ou ')}`,
        userType: req.user.user_type,
        allowedTypes
      });
    }

    next();
  };
};

// Middleware pour vérifier les documents d'identité
const requireVerifiedDocuments = async (req, res, next) => {
  try {
    if (!req.user) {
      return res.status(401).json({
        error: 'Authentification requise'
      });
    }
    
    // Vérifier si l'utilisateur a au moins un document approuvé
    const db = require('../config/database');
    const result = await db.query(
      'SELECT COUNT(*) as approved_count FROM user_documents WHERE user_id = $1 AND verification_status = $2',
      [req.user.userId, 'approved']
    );
    
    const approvedCount = parseInt(result.rows[0].approved_count);
    
    if (approvedCount === 0) {
      return res.status(403).json({
        error: 'Documents d\'identité vérifiés requis pour cette action',
        code: 'DOCUMENTS_REQUIRED',
        message: 'Veuillez uploader et faire vérifier vos documents d\'identité'
      });
    }
    
    next();
  } catch (error) {
    console.error('Erreur vérification documents:', error);
    res.status(500).json({
      error: 'Erreur lors de la vérification des documents'
    });
  }
};

// Fonction utilitaire pour vérifier les permissions
const checkUserPermissions = (user, requiredType = null, requireVerified = false, requireDocuments = false) => {
  const permissions = {
    canAccess: true,
    canCreateTrips: false,
    canSendPackages: false,
    canMessage: false,
    isVerified: user.is_verified,
    hasDocuments: false, // À déterminer par une requête DB
    restrictions: []
  };
  
  // Vérifier le type d'utilisateur
  if (requiredType && !requiredType.includes(user.user_type)) {
    permissions.canAccess = false;
    permissions.restrictions.push(`Type d'utilisateur requis: ${requiredType.join(' ou ')}`);
  }
  
  // Vérifier la vérification email
  if (requireVerified && !user.is_verified) {
    permissions.canAccess = false;
    permissions.restrictions.push('Email non vérifié');
  }
  
  // Définir les permissions selon le type d'utilisateur
  switch (user.user_type) {
    case 'traveler':
      permissions.canCreateTrips = true;
      permissions.canMessage = true;
      break;
    case 'sender':
      permissions.canSendPackages = true;
      permissions.canMessage = true;
      break;
    case 'both':
      permissions.canCreateTrips = true;
      permissions.canSendPackages = true;
      permissions.canMessage = true;
      break;
  }
  
  return permissions;
};

// Middleware pour vérifier que l'utilisateur est vérifié
const requireVerified = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({
      error: 'Authentification requise'
    });
  }

  if (!req.user.is_verified) {
    return res.status(403).json({
      error: 'Compte non vérifié. Veuillez vérifier votre compte pour accéder à cette fonctionnalité.'
    });
  }

  next();
};

module.exports = {
  auth,
  optionalAuth,
  requireUserType,
  requireVerified,
  requireVerifiedDocuments,
  checkUserPermissions
};