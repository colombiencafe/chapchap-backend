const express = require('express');
const path = require('path');
const fs = require('fs').promises;
const { auth } = require('../middleware/auth');
const fileService = require('../services/fileService');
const db = require('../config/database');

const router = express.Router();

/**
 * Routes pour la gestion des fichiers ChapChap
 */

/**
 * @route GET /api/files/messages/:filename
 * @desc Servir un fichier de message de manière sécurisée
 * @access Private
 */
router.get('/messages/:filename', auth, async (req, res) => {
  try {
    const { filename } = req.params;
    const userId = req.user.userId;
    
    // Construire le chemin du fichier
    const filePath = path.join(fileService.UPLOAD_DIRS.messages, filename);
    
    // Valider le chemin de fichier
    const validation = fileService.validateFilePath(filePath);
    if (!validation.isValid) {
      return res.status(400).json({
        success: false,
        message: validation.error
      });
    }

    // Vérifier que le fichier existe
    const fileInfo = await fileService.getFileInfo(filePath);
    if (!fileInfo.exists) {
      return res.status(404).json({
        success: false,
        message: 'Fichier non trouvé'
      });
    }

    // Vérifier que l'utilisateur a accès à ce fichier
    const accessQuery = `
      SELECT m.id, m.sender_id, m.receiver_id
      FROM messages m
      WHERE m.attachment_path = $1
      AND (m.sender_id = $2 OR m.receiver_id = $2)
    `;
    const accessResult = await db.query(accessQuery, [filePath, userId]);
    
    if (accessResult.rows.length === 0) {
      return res.status(403).json({
        success: false,
        message: 'Accès non autorisé à ce fichier'
      });
    }

    // Déterminer le type MIME
    const ext = path.extname(filename).toLowerCase();
    let mimeType = 'application/octet-stream';
    
    if (fileService.ALLOWED_FILE_TYPES.images.includes(ext)) {
      mimeType = `image/${ext.substring(1)}`;
    } else if (ext === '.pdf') {
      mimeType = 'application/pdf';
    } else if (ext === '.txt') {
      mimeType = 'text/plain';
    }

    // Définir les en-têtes de réponse
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    res.setHeader('Cache-Control', 'private, max-age=3600'); // Cache 1 heure
    
    // Envoyer le fichier
    res.sendFile(path.resolve(filePath));

  } catch (error) {
    console.error('Erreur lors de la récupération du fichier:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de la récupération du fichier',
      error: error.message
    });
  }
});

/**
 * @route GET /api/files/download/messages/:filename
 * @desc Télécharger un fichier de message
 * @access Private
 */
router.get('/download/messages/:filename', auth, async (req, res) => {
  try {
    const { filename } = req.params;
    const userId = req.user.userId;
    
    // Construire le chemin du fichier
    const filePath = path.join(fileService.UPLOAD_DIRS.messages, filename);
    
    // Valider le chemin de fichier
    const validation = fileService.validateFilePath(filePath);
    if (!validation.isValid) {
      return res.status(400).json({
        success: false,
        message: validation.error
      });
    }

    // Vérifier que le fichier existe
    const fileInfo = await fileService.getFileInfo(filePath);
    if (!fileInfo.exists) {
      return res.status(404).json({
        success: false,
        message: 'Fichier non trouvé'
      });
    }

    // Vérifier l'accès et récupérer le nom original
    const accessQuery = `
      SELECT m.id, m.sender_id, m.receiver_id, m.attachment_name
      FROM messages m
      WHERE m.attachment_path = $1
      AND (m.sender_id = $2 OR m.receiver_id = $2)
    `;
    const accessResult = await db.query(accessQuery, [filePath, userId]);
    
    if (accessResult.rows.length === 0) {
      return res.status(403).json({
        success: false,
        message: 'Accès non autorisé à ce fichier'
      });
    }

    const originalName = accessResult.rows[0].attachment_name || filename;

    // Définir les en-têtes pour le téléchargement
    res.setHeader('Content-Disposition', `attachment; filename="${originalName}"`);
    res.setHeader('Content-Type', 'application/octet-stream');
    
    // Envoyer le fichier
    res.sendFile(path.resolve(filePath));

  } catch (error) {
    console.error('Erreur lors du téléchargement du fichier:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors du téléchargement du fichier',
      error: error.message
    });
  }
});

/**
 * @route POST /api/files/upload/test
 * @desc Tester l'upload de fichier
 * @access Private
 */
router.post('/upload/test', auth, async (req, res) => {
  try {
    const fileInfo = await fileService.processMessageFileUpload(req, res);
    
    if (!fileInfo) {
      return res.status(400).json({
        success: false,
        message: 'Aucun fichier fourni'
      });
    }

    res.json({
      success: true,
      message: 'Fichier uploadé avec succès',
      data: {
        filename: fileInfo.filename,
        originalName: fileInfo.originalName,
        size: fileInfo.size,
        type: fileInfo.type,
        mimeType: fileInfo.mimeType,
        url: fileService.getPublicFileUrl(fileInfo.path)
      }
    });

  } catch (error) {
    console.error('Erreur lors de l\'upload de test:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de l\'upload de test',
      error: error.message
    });
  }
});

/**
 * @route GET /api/files/info/:filename
 * @desc Obtenir les informations d'un fichier
 * @access Private
 */
router.get('/info/:filename', auth, async (req, res) => {
  try {
    const { filename } = req.params;
    const userId = req.user.userId;
    
    // Construire le chemin du fichier
    const filePath = path.join(fileService.UPLOAD_DIRS.messages, filename);
    
    // Vérifier l'accès au fichier
    const accessQuery = `
      SELECT m.id, m.attachment_name, m.attachment_size, m.attachment_type, m.created_at
      FROM messages m
      WHERE m.attachment_path = $1
      AND (m.sender_id = $2 OR m.receiver_id = $2)
    `;
    const accessResult = await db.query(accessQuery, [filePath, userId]);
    
    if (accessResult.rows.length === 0) {
      return res.status(403).json({
        success: false,
        message: 'Accès non autorisé à ce fichier'
      });
    }

    const messageFile = accessResult.rows[0];
    const fileInfo = await fileService.getFileInfo(filePath);

    res.json({
      success: true,
      data: {
        filename: filename,
        originalName: messageFile.attachment_name,
        size: messageFile.attachment_size,
        mimeType: messageFile.attachment_type,
        uploadedAt: messageFile.created_at,
        exists: fileInfo.exists,
        url: fileService.getPublicFileUrl(filePath),
        downloadUrl: `/api/files/download/messages/${filename}`
      }
    });

  } catch (error) {
    console.error('Erreur lors de la récupération des informations du fichier:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de la récupération des informations du fichier',
      error: error.message
    });
  }
});

/**
 * @route GET /api/files/storage/stats
 * @desc Obtenir les statistiques de stockage
 * @access Private (Admin seulement)
 */
router.get('/storage/stats', auth, async (req, res) => {
  try {
    // Vérifier si l'utilisateur est admin (optionnel)
    // const userQuery = await db.query('SELECT role FROM users WHERE id = $1', [req.user.userId]);
    // if (userQuery.rows[0]?.role !== 'admin') {
    //   return res.status(403).json({ success: false, message: 'Accès admin requis' });
    // }

    const stats = await fileService.getStorageStats();
    
    if (!stats) {
      return res.status(500).json({
        success: false,
        message: 'Erreur lors du calcul des statistiques'
      });
    }

    // Convertir les tailles en format lisible
    const formatSize = (bytes) => {
      if (bytes === 0) return '0 B';
      const k = 1024;
      const sizes = ['B', 'KB', 'MB', 'GB'];
      const i = Math.floor(Math.log(bytes) / Math.log(k));
      return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    };

    res.json({
      success: true,
      data: {
        totalFiles: stats.totalFiles,
        totalSize: formatSize(stats.totalSize),
        totalSizeBytes: stats.totalSize,
        byType: {
          images: {
            count: stats.byType.images.count,
            size: formatSize(stats.byType.images.size),
            sizeBytes: stats.byType.images.size
          },
          documents: {
            count: stats.byType.documents.count,
            size: formatSize(stats.byType.documents.size),
            sizeBytes: stats.byType.documents.size
          },
          archives: {
            count: stats.byType.archives.count,
            size: formatSize(stats.byType.archives.size),
            sizeBytes: stats.byType.archives.size
          }
        }
      }
    });

  } catch (error) {
    console.error('Erreur lors de la récupération des statistiques de stockage:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de la récupération des statistiques de stockage',
      error: error.message
    });
  }
});

/**
 * @route POST /api/files/cleanup
 * @desc Nettoyer les fichiers temporaires
 * @access Private (Admin seulement)
 */
router.post('/cleanup', auth, async (req, res) => {
  try {
    const { maxAgeHours = 24 } = req.body;
    
    const deletedCount = await fileService.cleanupTempFiles(maxAgeHours);
    
    res.json({
      success: true,
      message: `Nettoyage terminé: ${deletedCount} fichiers supprimés`,
      data: {
        deletedFiles: deletedCount,
        maxAgeHours: maxAgeHours
      }
    });

  } catch (error) {
    console.error('Erreur lors du nettoyage:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors du nettoyage',
      error: error.message
    });
  }
});

module.exports = router;