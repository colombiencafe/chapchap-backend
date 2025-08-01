const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

// Créer le dossier uploads s'il n'existe pas
const uploadsDir = path.join(__dirname, '../uploads');
const documentsDir = path.join(uploadsDir, 'documents');

if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

if (!fs.existsSync(documentsDir)) {
  fs.mkdirSync(documentsDir, { recursive: true });
}

// Configuration du stockage
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, documentsDir);
  },
  filename: (req, file, cb) => {
    // Générer un nom unique pour le fichier
    const uniqueName = `${uuidv4()}-${Date.now()}${path.extname(file.originalname)}`;
    cb(null, uniqueName);
  }
});

// Filtrer les types de fichiers autorisés
const fileFilter = (req, file, cb) => {
  // Types MIME autorisés pour les documents d'identité
  const allowedMimes = [
    'image/jpeg',
    'image/jpg', 
    'image/png',
    'image/webp',
    'application/pdf'
  ];
  
  if (allowedMimes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Type de fichier non autorisé. Formats acceptés: JPG, PNG, WEBP, PDF'), false);
  }
};

// Configuration multer
const upload = multer({
  storage: storage,
  fileFilter: fileFilter,
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB max
    files: 3 // Maximum 3 fichiers par upload
  }
});

// Middleware pour upload de documents d'identité
const uploadDocuments = upload.fields([
  { name: 'passport', maxCount: 1 },
  { name: 'nationalId', maxCount: 1 },
  { name: 'drivingLicense', maxCount: 1 }
]);

// Middleware pour gérer les erreurs d'upload
const handleUploadError = (error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({
        error: 'Fichier trop volumineux. Taille maximum: 5MB'
      });
    }
    if (error.code === 'LIMIT_FILE_COUNT') {
      return res.status(400).json({
        error: 'Trop de fichiers. Maximum 3 fichiers autorisés'
      });
    }
    if (error.code === 'LIMIT_UNEXPECTED_FILE') {
      return res.status(400).json({
        error: 'Champ de fichier inattendu'
      });
    }
  }
  
  if (error.message.includes('Type de fichier non autorisé')) {
    return res.status(400).json({
      error: error.message
    });
  }
  
  return res.status(500).json({
    error: 'Erreur lors de l\'upload du fichier'
  });
};

// Fonction pour supprimer un fichier
const deleteFile = (filename) => {
  try {
    const filePath = path.join(documentsDir, filename);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      console.log(`📁 Fichier supprimé: ${filename}`);
    }
  } catch (error) {
    console.error('❌ Erreur suppression fichier:', error);
  }
};

// Fonction pour valider les documents uploadés
const validateDocuments = (files) => {
  const errors = [];
  const validatedDocs = {};
  
  // Vérifier chaque type de document
  const documentTypes = ['passport', 'nationalId', 'drivingLicense'];
  
  documentTypes.forEach(type => {
    if (files[type] && files[type][0]) {
      const file = files[type][0];
      
      // Vérifier la taille
      if (file.size > 5 * 1024 * 1024) {
        errors.push(`${type}: Fichier trop volumineux (max 5MB)`);
        return;
      }
      
      // Vérifier l'extension
      const allowedExtensions = ['.jpg', '.jpeg', '.png', '.webp', '.pdf'];
      const fileExtension = path.extname(file.originalname).toLowerCase();
      
      if (!allowedExtensions.includes(fileExtension)) {
        errors.push(`${type}: Extension non autorisée (${fileExtension})`);
        return;
      }
      
      validatedDocs[type] = {
        filename: file.filename,
        originalName: file.originalname,
        mimetype: file.mimetype,
        size: file.size,
        path: file.path
      };
    }
  });
  
  return { errors, validatedDocs };
};

// Fonction pour obtenir l'URL publique d'un document
const getDocumentUrl = (filename) => {
  if (!filename) return null;
  return `${process.env.API_URL || 'http://localhost:3000'}/uploads/documents/${filename}`;
};

// Fonction pour nettoyer les anciens fichiers (à exécuter périodiquement)
const cleanupOldFiles = () => {
  try {
    const files = fs.readdirSync(documentsDir);
    const now = Date.now();
    const maxAge = 30 * 24 * 60 * 60 * 1000; // 30 jours
    
    files.forEach(file => {
      const filePath = path.join(documentsDir, file);
      const stats = fs.statSync(filePath);
      
      if (now - stats.mtime.getTime() > maxAge) {
        fs.unlinkSync(filePath);
        console.log(`🗑️ Fichier ancien supprimé: ${file}`);
      }
    });
  } catch (error) {
    console.error('❌ Erreur nettoyage fichiers:', error);
  }
};

// Types de documents autorisés avec leurs labels
const DOCUMENT_TYPES = {
  passport: {
    label: 'Passeport',
    required: false,
    description: 'Page principale du passeport avec photo'
  },
  nationalId: {
    label: 'Carte d\'identité nationale',
    required: false,
    description: 'Carte d\'identité ou carte de résident'
  },
  drivingLicense: {
    label: 'Permis de conduire',
    required: false,
    description: 'Permis de conduire valide'
  }
};

// Statuts de vérification des documents
const VERIFICATION_STATUS = {
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  EXPIRED: 'expired'
};

module.exports = {
  uploadDocuments,
  handleUploadError,
  deleteFile,
  validateDocuments,
  getDocumentUrl,
  cleanupOldFiles,
  DOCUMENT_TYPES,
  VERIFICATION_STATUS,
  uploadsDir,
  documentsDir
};