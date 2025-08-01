const multer = require('multer');
const path = require('path');
const fs = require('fs').promises;
const crypto = require('crypto');

/**
 * Service de gestion des fichiers pour ChapChap
 * Gère l'upload, le stockage et la sécurité des fichiers
 */

// Configuration des dossiers d'upload
const UPLOAD_DIRS = {
  messages: 'uploads/messages',
  profiles: 'uploads/profiles',
  temp: 'uploads/temp'
};

// Types de fichiers autorisés
const ALLOWED_FILE_TYPES = {
  images: ['.jpg', '.jpeg', '.png', '.gif', '.webp'],
  documents: ['.pdf', '.doc', '.docx', '.txt', '.rtf'],
  archives: ['.zip', '.rar', '.7z']
};

// Tailles maximales (en bytes)
const MAX_FILE_SIZES = {
  image: 5 * 1024 * 1024, // 5MB
  document: 10 * 1024 * 1024, // 10MB
  archive: 20 * 1024 * 1024 // 20MB
};

/**
 * Créer les dossiers d'upload s'ils n'existent pas
 */
const ensureUploadDirs = async () => {
  try {
    for (const dir of Object.values(UPLOAD_DIRS)) {
      await fs.mkdir(dir, { recursive: true });
    }
  } catch (error) {
    console.error('Erreur lors de la création des dossiers d\'upload:', error);
  }
};

/**
 * Générer un nom de fichier unique
 * @param {string} originalName - Nom original du fichier
 * @returns {string} Nom de fichier unique
 */
const generateUniqueFileName = (originalName) => {
  const ext = path.extname(originalName).toLowerCase();
  const timestamp = Date.now();
  const randomString = crypto.randomBytes(8).toString('hex');
  return `${timestamp}_${randomString}${ext}`;
};

/**
 * Valider le type de fichier
 * @param {string} filename - Nom du fichier
 * @returns {Object} Résultat de validation
 */
const validateFileType = (filename) => {
  const ext = path.extname(filename).toLowerCase();
  
  // Vérifier les images
  if (ALLOWED_FILE_TYPES.images.includes(ext)) {
    return { isValid: true, type: 'image', maxSize: MAX_FILE_SIZES.image };
  }
  
  // Vérifier les documents
  if (ALLOWED_FILE_TYPES.documents.includes(ext)) {
    return { isValid: true, type: 'document', maxSize: MAX_FILE_SIZES.document };
  }
  
  // Vérifier les archives
  if (ALLOWED_FILE_TYPES.archives.includes(ext)) {
    return { isValid: true, type: 'archive', maxSize: MAX_FILE_SIZES.archive };
  }
  
  return { isValid: false, error: 'Type de fichier non autorisé' };
};

/**
 * Configuration de multer pour les messages
 */
const messageUploadConfig = multer({
  storage: multer.diskStorage({
    destination: async (req, file, cb) => {
      await ensureUploadDirs();
      cb(null, UPLOAD_DIRS.messages);
    },
    filename: (req, file, cb) => {
      const uniqueName = generateUniqueFileName(file.originalname);
      cb(null, uniqueName);
    }
  }),
  fileFilter: (req, file, cb) => {
    const validation = validateFileType(file.originalname);
    if (validation.isValid) {
      req.fileValidation = validation;
      cb(null, true);
    } else {
      cb(new Error(validation.error), false);
    }
  },
  limits: {
    fileSize: Math.max(...Object.values(MAX_FILE_SIZES)) // Taille max globale
  }
});

/**
 * Middleware pour l'upload de fichiers de messages
 */
const uploadMessageFile = messageUploadConfig.single('attachment');

/**
 * Traiter l'upload d'un fichier pour un message
 * @param {Object} req - Requête Express
 * @param {Object} res - Réponse Express
 * @returns {Promise<Object>} Informations du fichier uploadé
 */
const processMessageFileUpload = async (req, res) => {
  return new Promise((resolve, reject) => {
    uploadMessageFile(req, res, (err) => {
      if (err) {
        if (err instanceof multer.MulterError) {
          if (err.code === 'LIMIT_FILE_SIZE') {
            reject(new Error('Fichier trop volumineux'));
          } else {
            reject(new Error(`Erreur d'upload: ${err.message}`));
          }
        } else {
          reject(err);
        }
        return;
      }

      if (!req.file) {
        resolve(null);
        return;
      }

      // Vérifier la taille selon le type de fichier
      const validation = req.fileValidation;
      if (req.file.size > validation.maxSize) {
        // Supprimer le fichier uploadé
        fs.unlink(req.file.path).catch(console.error);
        reject(new Error(`Fichier trop volumineux pour le type ${validation.type}`));
        return;
      }

      resolve({
        path: req.file.path,
        filename: req.file.filename,
        originalName: req.file.originalname,
        size: req.file.size,
        type: validation.type,
        mimeType: req.file.mimetype
      });
    });
  });
};

/**
 * Supprimer un fichier
 * @param {string} filePath - Chemin du fichier
 * @returns {Promise<boolean>} Succès
 */
const deleteFile = async (filePath) => {
  try {
    await fs.unlink(filePath);
    return true;
  } catch (error) {
    console.error('Erreur lors de la suppression du fichier:', error);
    return false;
  }
};

/**
 * Obtenir les informations d'un fichier
 * @param {string} filePath - Chemin du fichier
 * @returns {Promise<Object>} Informations du fichier
 */
const getFileInfo = async (filePath) => {
  try {
    const stats = await fs.stat(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const validation = validateFileType(filePath);
    
    return {
      exists: true,
      size: stats.size,
      type: validation.isValid ? validation.type : 'unknown',
      extension: ext,
      createdAt: stats.birthtime,
      modifiedAt: stats.mtime
    };
  } catch (error) {
    return {
      exists: false,
      error: error.message
    };
  }
};

/**
 * Nettoyer les fichiers temporaires anciens
 * @param {number} maxAgeHours - Âge maximum en heures
 * @returns {Promise<number>} Nombre de fichiers supprimés
 */
const cleanupTempFiles = async (maxAgeHours = 24) => {
  try {
    const tempDir = UPLOAD_DIRS.temp;
    const files = await fs.readdir(tempDir);
    const maxAge = maxAgeHours * 60 * 60 * 1000; // Convertir en millisecondes
    const now = Date.now();
    let deletedCount = 0;

    for (const file of files) {
      const filePath = path.join(tempDir, file);
      const stats = await fs.stat(filePath);
      
      if (now - stats.mtime.getTime() > maxAge) {
        await fs.unlink(filePath);
        deletedCount++;
      }
    }

    return deletedCount;
  } catch (error) {
    console.error('Erreur lors du nettoyage des fichiers temporaires:', error);
    return 0;
  }
};

/**
 * Obtenir l'URL publique d'un fichier
 * @param {string} filePath - Chemin du fichier
 * @returns {string} URL publique
 */
const getPublicFileUrl = (filePath) => {
  // Convertir le chemin système en URL
  const relativePath = filePath.replace(/\\/g, '/');
  return `/api/files/${relativePath.replace('uploads/', '')}`;
};

/**
 * Valider et sécuriser un chemin de fichier
 * @param {string} filePath - Chemin du fichier
 * @returns {Object} Résultat de validation
 */
const validateFilePath = (filePath) => {
  try {
    // Empêcher les attaques de traversée de répertoire
    const normalizedPath = path.normalize(filePath);
    
    if (normalizedPath.includes('..')) {
      return { isValid: false, error: 'Chemin de fichier non sécurisé' };
    }

    // Vérifier que le fichier est dans un dossier autorisé
    const isInAllowedDir = Object.values(UPLOAD_DIRS).some(dir => 
      normalizedPath.startsWith(dir)
    );

    if (!isInAllowedDir) {
      return { isValid: false, error: 'Accès au fichier non autorisé' };
    }

    return { isValid: true, path: normalizedPath };
  } catch (error) {
    return { isValid: false, error: 'Chemin de fichier invalide' };
  }
};

/**
 * Obtenir les statistiques d'utilisation du stockage
 * @returns {Promise<Object>} Statistiques
 */
const getStorageStats = async () => {
  try {
    const stats = {
      totalFiles: 0,
      totalSize: 0,
      byType: {
        images: { count: 0, size: 0 },
        documents: { count: 0, size: 0 },
        archives: { count: 0, size: 0 }
      }
    };

    for (const [dirName, dirPath] of Object.entries(UPLOAD_DIRS)) {
      try {
        const files = await fs.readdir(dirPath);
        
        for (const file of files) {
          const filePath = path.join(dirPath, file);
          const fileStats = await fs.stat(filePath);
          
          if (fileStats.isFile()) {
            stats.totalFiles++;
            stats.totalSize += fileStats.size;
            
            const validation = validateFileType(file);
            if (validation.isValid) {
              stats.byType[validation.type].count++;
              stats.byType[validation.type].size += fileStats.size;
            }
          }
        }
      } catch (error) {
        // Dossier n'existe pas encore
        continue;
      }
    }

    return stats;
  } catch (error) {
    console.error('Erreur lors du calcul des statistiques:', error);
    return null;
  }
};

/**
 * Traiter l'upload d'une photo de suivi
 * @param {Object} file - Fichier uploadé
 * @returns {Object} Résultat du traitement
 */
const processTrackingPhotoUpload = async (file) => {
  try {
    // Vérifier le type de fichier
    const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
    if (!allowedTypes.includes(file.mimetype)) {
      throw new Error('Type de fichier non autorisé. Seules les images sont acceptées.');
    }

    // Vérifier la taille (max 5MB)
    const maxSize = 5 * 1024 * 1024;
    if (file.size > maxSize) {
      throw new Error('Fichier trop volumineux. Taille maximale: 5MB');
    }

    // Créer le dossier de destination
    const uploadDir = path.join(__dirname, '..', 'uploads', 'tracking');
    await fs.mkdir(uploadDir, { recursive: true });

    // Générer un nom de fichier unique
    const fileExtension = path.extname(file.name);
    const fileName = `tracking_${Date.now()}_${Math.random().toString(36).substring(7)}${fileExtension}`;
    const filePath = path.join(uploadDir, fileName);

    // Sauvegarder le fichier
    await file.mv(filePath);

    return {
      success: true,
      filePath: `uploads/tracking/${fileName}`,
      originalName: file.name,
      size: file.size,
      mimetype: file.mimetype
    };

  } catch (error) {
    console.error('Erreur lors du traitement de la photo de suivi:', error);
    return {
      success: false,
      error: error.message
    };
  }
};

/**
 * Traiter l'upload d'une photo de preuve pour litige
 * @param {Object} file - Fichier uploadé
 * @returns {Object} Résultat du traitement
 */
const processDisputePhotoUpload = async (file) => {
  try {
    // Vérifier le type de fichier
    const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
    if (!allowedTypes.includes(file.mimetype)) {
      throw new Error('Type de fichier non autorisé. Seules les images sont acceptées.');
    }

    // Vérifier la taille (max 10MB pour les preuves)
    const maxSize = 10 * 1024 * 1024;
    if (file.size > maxSize) {
      throw new Error('Fichier trop volumineux. Taille maximale: 10MB');
    }

    // Créer le dossier de destination
    const uploadDir = path.join(__dirname, '..', 'uploads', 'disputes');
    await fs.mkdir(uploadDir, { recursive: true });

    // Générer un nom de fichier unique
    const fileExtension = path.extname(file.name);
    const fileName = `dispute_${Date.now()}_${Math.random().toString(36).substring(7)}${fileExtension}`;
    const filePath = path.join(uploadDir, fileName);

    // Sauvegarder le fichier
    await file.mv(filePath);

    return {
      success: true,
      filePath: `uploads/disputes/${fileName}`,
      originalName: file.name,
      size: file.size,
      mimetype: file.mimetype
    };

  } catch (error) {
    console.error('Erreur lors du traitement de la photo de litige:', error);
    return {
      success: false,
      error: error.message
    };
  }
};

module.exports = {
  uploadMessageFile,
  processMessageFileUpload,
  processTrackingPhotoUpload,
  processDisputePhotoUpload,
  deleteFile,
  getFileInfo,
  cleanupTempFiles,
  getPublicFileUrl,
  validateFilePath,
  getStorageStats,
  ensureUploadDirs,
  UPLOAD_DIRS,
  ALLOWED_FILE_TYPES,
  MAX_FILE_SIZES
};