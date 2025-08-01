const express = require('express');
const { body, validationResult } = require('express-validator');
const db = require('../config/database');
const { auth } = require('../middleware/auth');
const { 
  uploadDocuments, 
  handleUploadError, 
  validateDocuments, 
  getDocumentUrl, 
  deleteFile,
  DOCUMENT_TYPES,
  VERIFICATION_STATUS 
} = require('../services/uploadService');

const router = express.Router();

// Route pour uploader des documents d'identité
router.post('/upload', auth, (req, res) => {
  uploadDocuments(req, res, async (err) => {
    if (err) {
      return handleUploadError(err, req, res, () => {});
    }
    
    try {
      // Valider les fichiers uploadés
      const { errors, validatedDocs } = validateDocuments(req.files);
      
      if (errors.length > 0) {
        // Supprimer les fichiers en cas d'erreur de validation
        Object.values(req.files).flat().forEach(file => {
          deleteFile(file.filename);
        });
        
        return res.status(400).json({
          error: 'Erreurs de validation des documents',
          details: errors
        });
      }
      
      if (Object.keys(validatedDocs).length === 0) {
        return res.status(400).json({
          error: 'Aucun document valide fourni'
        });
      }
      
      const uploadedDocs = [];
      
      // Sauvegarder chaque document en base de données
      for (const [docType, docInfo] of Object.entries(validatedDocs)) {
        try {
          // Supprimer l'ancien document du même type s'il existe
          const existingDoc = await db.query(
            'SELECT filename FROM user_documents WHERE user_id = $1 AND document_type = $2',
            [req.user.userId, docType]
          );
          
          if (existingDoc.rows.length > 0) {
            deleteFile(existingDoc.rows[0].filename);
            
            // Mettre à jour le document existant
            await db.query(
              `UPDATE user_documents 
               SET filename = $1, original_name = $2, mimetype = $3, size = $4, 
                   verification_status = 'pending', rejection_reason = NULL, 
                   verified_at = NULL, verified_by = NULL, uploaded_at = NOW()
               WHERE user_id = $5 AND document_type = $6`,
              [docInfo.filename, docInfo.originalName, docInfo.mimetype, 
               docInfo.size, req.user.userId, docType]
            );
          } else {
            // Insérer un nouveau document
            await db.query(
              `INSERT INTO user_documents 
               (user_id, document_type, filename, original_name, mimetype, size) 
               VALUES ($1, $2, $3, $4, $5, $6)`,
              [req.user.userId, docType, docInfo.filename, docInfo.originalName, 
               docInfo.mimetype, docInfo.size]
            );
          }
          
          uploadedDocs.push({
            type: docType,
            label: DOCUMENT_TYPES[docType].label,
            filename: docInfo.filename,
            originalName: docInfo.originalName,
            size: docInfo.size,
            url: getDocumentUrl(docInfo.filename),
            status: 'pending'
          });
          
        } catch (dbError) {
          console.error(`Erreur sauvegarde document ${docType}:`, dbError);
          deleteFile(docInfo.filename);
          throw dbError;
        }
      }
      
      res.status(201).json({
        message: `${uploadedDocs.length} document(s) uploadé(s) avec succès`,
        documents: uploadedDocs,
        info: 'Les documents sont en cours de vérification par notre équipe'
      });
      
    } catch (error) {
      console.error('Erreur lors de l\'upload:', error);
      
      // Nettoyer les fichiers en cas d'erreur
      if (req.files) {
        Object.values(req.files).flat().forEach(file => {
          deleteFile(file.filename);
        });
      }
      
      res.status(500).json({
        error: 'Erreur interne du serveur lors de l\'upload'
      });
    }
  });
});

// Route pour obtenir la liste des documents de l'utilisateur
router.get('/my-documents', auth, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT document_type, filename, original_name, mimetype, size, 
              verification_status, rejection_reason, verified_at, uploaded_at
       FROM user_documents 
       WHERE user_id = $1 
       ORDER BY uploaded_at DESC`,
      [req.user.userId]
    );
    
    const documents = result.rows.map(doc => ({
      type: doc.document_type,
      label: DOCUMENT_TYPES[doc.document_type]?.label || doc.document_type,
      filename: doc.filename,
      originalName: doc.original_name,
      mimetype: doc.mimetype,
      size: doc.size,
      url: getDocumentUrl(doc.filename),
      status: doc.verification_status,
      rejectionReason: doc.rejection_reason,
      verifiedAt: doc.verified_at,
      uploadedAt: doc.uploaded_at
    }));
    
    // Ajouter les types de documents manquants
    const uploadedTypes = documents.map(doc => doc.type);
    const missingTypes = Object.keys(DOCUMENT_TYPES).filter(type => 
      !uploadedTypes.includes(type)
    );
    
    const missingDocs = missingTypes.map(type => ({
      type,
      label: DOCUMENT_TYPES[type].label,
      description: DOCUMENT_TYPES[type].description,
      required: DOCUMENT_TYPES[type].required,
      status: 'not_uploaded'
    }));
    
    res.json({
      uploaded: documents,
      missing: missingDocs,
      summary: {
        total: documents.length,
        pending: documents.filter(d => d.status === 'pending').length,
        approved: documents.filter(d => d.status === 'approved').length,
        rejected: documents.filter(d => d.status === 'rejected').length
      }
    });
    
  } catch (error) {
    console.error('Erreur récupération documents:', error);
    res.status(500).json({
      error: 'Erreur interne du serveur lors de la récupération'
    });
  }
});

// Route pour supprimer un document
router.delete('/:documentType', auth, async (req, res) => {
  try {
    const { documentType } = req.params;
    
    if (!DOCUMENT_TYPES[documentType]) {
      return res.status(400).json({
        error: 'Type de document invalide'
      });
    }
    
    // Récupérer le document à supprimer
    const result = await db.query(
      'SELECT filename FROM user_documents WHERE user_id = $1 AND document_type = $2',
      [req.user.userId, documentType]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({
        error: 'Document non trouvé'
      });
    }
    
    const filename = result.rows[0].filename;
    
    // Supprimer de la base de données
    await db.query(
      'DELETE FROM user_documents WHERE user_id = $1 AND document_type = $2',
      [req.user.userId, documentType]
    );
    
    // Supprimer le fichier physique
    deleteFile(filename);
    
    res.json({
      message: `Document ${DOCUMENT_TYPES[documentType].label} supprimé avec succès`
    });
    
  } catch (error) {
    console.error('Erreur suppression document:', error);
    res.status(500).json({
      error: 'Erreur interne du serveur lors de la suppression'
    });
  }
});

// Route pour obtenir les types de documents autorisés
router.get('/types', (req, res) => {
  res.json({
    documentTypes: DOCUMENT_TYPES,
    verificationStatuses: VERIFICATION_STATUS,
    uploadLimits: {
      maxFileSize: '5MB',
      allowedFormats: ['JPG', 'PNG', 'WEBP', 'PDF'],
      maxFiles: 3
    }
  });
});

// Route pour obtenir le statut de vérification global
router.get('/verification-status', auth, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT document_type, verification_status, verified_at, rejection_reason
       FROM user_documents 
       WHERE user_id = $1`,
      [req.user.userId]
    );
    
    const documents = result.rows;
    const totalDocs = documents.length;
    const approvedDocs = documents.filter(d => d.verification_status === 'approved').length;
    const pendingDocs = documents.filter(d => d.verification_status === 'pending').length;
    const rejectedDocs = documents.filter(d => d.verification_status === 'rejected').length;
    
    let globalStatus = 'incomplete';
    if (totalDocs === 0) {
      globalStatus = 'no_documents';
    } else if (approvedDocs > 0 && rejectedDocs === 0 && pendingDocs === 0) {
      globalStatus = 'verified';
    } else if (pendingDocs > 0) {
      globalStatus = 'pending';
    } else if (rejectedDocs > 0) {
      globalStatus = 'rejected';
    }
    
    res.json({
      globalStatus,
      summary: {
        total: totalDocs,
        approved: approvedDocs,
        pending: pendingDocs,
        rejected: rejectedDocs
      },
      documents: documents.map(doc => ({
        type: doc.document_type,
        label: DOCUMENT_TYPES[doc.document_type]?.label,
        status: doc.verification_status,
        verifiedAt: doc.verified_at,
        rejectionReason: doc.rejection_reason
      })),
      canPerformActions: globalStatus === 'verified' || globalStatus === 'pending'
    });
    
  } catch (error) {
    console.error('Erreur statut vérification:', error);
    res.status(500).json({
      error: 'Erreur interne du serveur lors de la vérification du statut'
    });
  }
});

module.exports = router;