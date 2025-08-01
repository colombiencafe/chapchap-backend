const express = require('express');
const { body, query, validationResult } = require('express-validator');
const db = require('../config/database');
const { auth } = require('../middleware/auth');
const messageService = require('../services/messageService');
const fileService = require('../services/fileService');

const router = express.Router();

// Validation pour envoyer un message
const sendMessageValidation = [
  body('receiverId')
    .isInt({ min: 1 })
    .withMessage('ID du destinataire invalide'),
  body('packageId')
    .optional()
    .isInt({ min: 1 })
    .withMessage('ID du colis invalide'),
  body('content')
    .trim()
    .isLength({ min: 1, max: 1000 })
    .withMessage('Le message doit contenir entre 1 et 1000 caractères')
];

// Validation pour la récupération des messages
const getMessagesValidation = [
  query('conversationWith')
    .optional()
    .isInt({ min: 1 })
    .withMessage('ID de conversation invalide'),
  query('packageId')
    .optional()
    .isInt({ min: 1 })
    .withMessage('ID du colis invalide'),
  query('page')
    .optional()
    .isInt({ min: 1 })
    .withMessage('Numéro de page invalide'),
  query('limit')
    .optional()
    .isInt({ min: 1, max: 100 })
    .withMessage('Limite invalide')
];

// Envoyer un message avec support de fichiers
router.post('/send', auth, async (req, res) => {
  try {
    // Traiter l'upload de fichier s'il y en a un
    let fileInfo = null;
    try {
      fileInfo = await fileService.processMessageFileUpload(req, res);
    } catch (uploadError) {
      return res.status(400).json({
        success: false,
        message: 'Erreur lors de l\'upload du fichier',
        error: uploadError.message
      });
    }

    const { receiverId, content, tripId, packageId } = req.body;
    
    // Validation des données requises
    if (!receiverId || (!content && !fileInfo) || !tripId || !packageId) {
      return res.status(400).json({
        success: false,
        message: 'Destinataire, contenu (ou fichier), voyage et colis requis'
      });
    }

    // Vérifier que l'utilisateur a accès au voyage et au colis
    const accessQuery = `
      SELECT t.user_id as trip_owner, p.user_id as package_owner
      FROM trips t, packages p
      WHERE t.id = $1 AND p.id = $2
    `;
    const accessResult = await db.query(accessQuery, [tripId, packageId]);
    
    if (accessResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Voyage ou colis non trouvé'
      });
    }

    const { trip_owner, package_owner } = accessResult.rows[0];
    const userId = req.user.userId;
    
    // Vérifier que l'utilisateur est soit le propriétaire du voyage, soit du colis
    if (userId !== trip_owner && userId !== package_owner) {
      return res.status(403).json({
        success: false,
        message: 'Accès non autorisé à cette conversation'
      });
    }

    // Vérifier que le destinataire est l'autre partie
    const expectedReceiverId = userId === trip_owner ? package_owner : trip_owner;
    if (parseInt(receiverId) !== expectedReceiverId) {
      return res.status(400).json({
        success: false,
        message: 'Destinataire invalide pour cette conversation'
      });
    }

    // Créer ou récupérer la conversation
    await messageService.getOrCreateConversation(
      parseInt(tripId),
      parseInt(packageId),
      package_owner,
      trip_owner
    );

    // Préparer les données du message
    const messageData = {
      senderId: userId,
      receiverId: parseInt(receiverId),
      content: content || (fileInfo ? `[Fichier: ${fileInfo.originalName}]` : ''),
      messageType: fileInfo ? fileInfo.type : 'text',
      tripId: parseInt(tripId),
      packageId: parseInt(packageId)
    };

    // Ajouter les informations du fichier si présent
    if (fileInfo) {
      messageData.attachmentPath = fileInfo.path;
      messageData.attachmentName = fileInfo.originalName;
      messageData.attachmentSize = fileInfo.size;
      messageData.attachmentType = fileInfo.mimeType;
    }

    // Envoyer le message
    const message = await messageService.sendMessage(messageData);
    
    // Émettre l'événement Socket.IO
    const socketService = req.app.get('socketService');
    if (socketService) {
      socketService.notifyNewMessage(parseInt(receiverId), {
        message: {
          id: message.id,
          content: message.content,
          messageType: message.message_type,
          sender: {
            id: message.sender_id,
            firstName: message.sender_first_name,
            lastName: message.sender_last_name,
            profilePicture: message.sender_profile_picture
          },
          attachment: message.attachment_path ? {
            path: fileService.getPublicFileUrl(message.attachment_path),
            name: message.attachment_name,
            size: message.attachment_size,
            type: message.attachment_type
          } : null,
          createdAt: message.created_at,
          tripId: parseInt(tripId),
          packageId: parseInt(packageId)
        }
      });
    }
    
    res.status(201).json({
      success: true,
      message: 'Message envoyé avec succès',
      data: {
        id: message.id,
        content: message.content,
        messageType: message.message_type,
        attachment: message.attachment_path ? {
          url: fileService.getPublicFileUrl(message.attachment_path),
          name: message.attachment_name,
          size: message.attachment_size,
          type: message.attachment_type
        } : null,
        createdAt: message.created_at
      }
    });
  } catch (error) {
    console.error('Erreur lors de l\'envoi du message:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de l\'envoi du message',
      error: error.message
    });
  }
});

// Récupérer toutes les conversations de l'utilisateur
router.get('/conversations', auth, async (req, res) => {
  try {
    const conversations = await messageService.getUserConversations(req.user.userId);
    
    res.json({
      success: true,
      data: conversations,
      count: conversations.length
    });
  } catch (error) {
    console.error('Erreur lors de la récupération des conversations:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de la récupération des conversations',
      error: error.message
    });
  }
});

// Obtenir les messages d'une conversation
router.get('/', auth, getMessagesValidation, async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        error: 'Paramètres invalides',
        details: errors.array()
      });
    }

    const { conversationWith, packageId, page = 1, limit = 50 } = req.query;
    const userId = req.user.userId;

    if (!conversationWith && !packageId) {
      return res.status(400).json({
        error: 'Vous devez spécifier soit conversationWith soit packageId'
      });
    }

    let whereConditions = [];
    let queryParams = [];
    let paramCount = 1;

    if (conversationWith) {
      whereConditions.push(
        `((m.sender_id = $${paramCount} AND m.receiver_id = $${paramCount + 1}) OR (m.sender_id = $${paramCount + 1} AND m.receiver_id = $${paramCount}))`
      );
      queryParams.push(userId, conversationWith);
      paramCount += 2;
    }

    if (packageId) {
      // Vérifier l'accès au colis
      const packageResult = await db.query(
        `SELECT p.id, p.sender_id, t.traveler_id
         FROM packages p
         JOIN trips t ON p.trip_id = t.id
         WHERE p.id = $1`,
        [packageId]
      );

      if (packageResult.rows.length === 0) {
        return res.status(404).json({
          error: 'Colis non trouvé'
        });
      }

      const packageData = packageResult.rows[0];
      const hasAccess = packageData.sender_id === userId || packageData.traveler_id === userId;

      if (!hasAccess) {
        return res.status(403).json({
          error: 'Accès non autorisé à ce colis'
        });
      }

      whereConditions.push(`m.package_id = $${paramCount}`);
      queryParams.push(packageId);
      paramCount++;
    }

    // Si pas de packageId spécifique, s'assurer que l'utilisateur est impliqué
    if (!packageId) {
      // Déjà géré par conversationWith
    } else {
      whereConditions.push(`(m.sender_id = $${paramCount} OR m.receiver_id = $${paramCount})`);
      queryParams.push(userId);
      paramCount++;
    }

    const offset = (page - 1) * limit;
    queryParams.push(limit, offset);

    const result = await db.query(
      `SELECT 
         m.*,
         sender.first_name as sender_first_name,
         sender.last_name as sender_last_name,
         sender.profile_picture as sender_profile_picture,
         receiver.first_name as receiver_first_name,
         receiver.last_name as receiver_last_name,
         receiver.profile_picture as receiver_profile_picture
       FROM messages m
       JOIN users sender ON m.sender_id = sender.id
       JOIN users receiver ON m.receiver_id = receiver.id
       WHERE ${whereConditions.join(' AND ')}
       ORDER BY m.created_at DESC
       LIMIT $${paramCount} OFFSET $${paramCount + 1}`,
      queryParams
    );

    const countResult = await db.query(
      `SELECT COUNT(*) as total
       FROM messages m
       WHERE ${whereConditions.join(' AND ')}`,
      queryParams.slice(0, -2)
    );

    const total = parseInt(countResult.rows[0].total);

    const messages = result.rows.map(msg => ({
      id: msg.id,
      senderId: msg.sender_id,
      receiverId: msg.receiver_id,
      packageId: msg.package_id,
      content: msg.content,
      isRead: msg.is_read,
      createdAt: msg.created_at,
      isFromMe: msg.sender_id === userId,
      sender: {
        firstName: msg.sender_first_name,
        lastName: msg.sender_last_name,
        profilePicture: msg.sender_profile_picture
      },
      receiver: {
        firstName: msg.receiver_first_name,
        lastName: msg.receiver_last_name,
        profilePicture: msg.receiver_profile_picture
      }
    }));

    // Marquer les messages reçus comme lus
    if (messages.length > 0) {
      const messageIds = messages
        .filter(msg => msg.receiverId === userId && !msg.isRead)
        .map(msg => msg.id);

      if (messageIds.length > 0) {
        await db.query(
          'UPDATE messages SET is_read = true WHERE id = ANY($1)',
          [messageIds]
        );
      }
    }

    res.json({
      messages: messages.reverse(), // Inverser pour avoir les plus anciens en premier
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        totalPages: Math.ceil(total / limit)
      }
    });

  } catch (error) {
    console.error('Erreur lors de la récupération des messages:', error);
    res.status(500).json({
      error: 'Erreur interne du serveur'
    });
  }
});

// Marquer des messages comme lus
router.patch('/mark-read', auth, async (req, res) => {
  try {
    const { messageIds, conversationWith } = req.body;
    const userId = req.user.userId;

    if (messageIds && Array.isArray(messageIds)) {
      // Marquer des messages spécifiques comme lus
      await db.query(
        'UPDATE messages SET is_read = true WHERE id = ANY($1) AND receiver_id = $2',
        [messageIds, userId]
      );
    } else if (conversationWith) {
      // Marquer tous les messages d'une conversation comme lus
      await db.query(
        'UPDATE messages SET is_read = true WHERE sender_id = $1 AND receiver_id = $2',
        [conversationWith, userId]
      );
    } else {
      return res.status(400).json({
        error: 'Vous devez spécifier soit messageIds soit conversationWith'
      });
    }

    res.json({
      message: 'Messages marqués comme lus'
    });

  } catch (error) {
    console.error('Erreur lors du marquage des messages:', error);
    res.status(500).json({
      error: 'Erreur interne du serveur'
    });
  }
});

// Obtenir le nombre de messages non lus
router.get('/unread-count', auth, async (req, res) => {
  try {
    const userId = req.user.userId;

    const result = await db.query(
      'SELECT COUNT(*) as unread_count FROM messages WHERE receiver_id = $1 AND is_read = false',
      [userId]
    );

    res.json({
      unreadCount: parseInt(result.rows[0].unread_count)
    });

  } catch (error) {
    console.error('Erreur lors de la récupération du nombre de messages non lus:', error);
    res.status(500).json({
      error: 'Erreur interne du serveur'
    });
  }
});

// Supprimer un message (seulement pour l'expéditeur)
router.delete('/:messageId', auth, async (req, res) => {
  try {
    const { messageId } = req.params;
    
    if (!messageId || isNaN(messageId)) {
      return res.status(400).json({
        success: false,
        message: 'ID de message requis et doit être un nombre'
      });
    }

    await messageService.deleteMessage(parseInt(messageId), req.user.userId);
    
    res.json({
      success: true,
      message: 'Message supprimé avec succès'
    });
  } catch (error) {
    console.error('Erreur lors de la suppression du message:', error);
    
    if (error.message.includes('non trouvé') || error.message.includes('non autorisé')) {
      return res.status(404).json({
        success: false,
        message: error.message
      });
    }
    
    res.status(500).json({
      success: false,
      message: 'Erreur lors de la suppression du message',
      error: error.message
    });
  }
});

/**
 * @route GET /api/messages/conversation/:tripId/:packageId
 * @desc Récupérer les messages d'une conversation spécifique
 * @access Private
 */
router.get('/conversation/:tripId/:packageId', auth, async (req, res) => {
  try {
    const { tripId, packageId } = req.params;
    const { page = 1, limit = 50 } = req.query;
    
    // Validation des paramètres
    if (!tripId || !packageId || isNaN(tripId) || isNaN(packageId)) {
      return res.status(400).json({
        success: false,
        message: 'ID de voyage et de colis requis et doivent être des nombres'
      });
    }

    const result = await messageService.getConversationMessages(
      parseInt(tripId),
      parseInt(packageId),
      req.user.userId,
      parseInt(page),
      parseInt(limit)
    );
    
    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    console.error('Erreur lors de la récupération des messages:', error);
    
    if (error.message.includes('non trouvée') || error.message.includes('non autorisé')) {
      return res.status(404).json({
        success: false,
        message: error.message
      });
    }
    
    res.status(500).json({
      success: false,
      message: 'Erreur lors de la récupération des messages',
      error: error.message
    });
  }
});

/**
 * @route PUT /api/messages/read/:tripId/:packageId
 * @desc Marquer les messages comme lus
 * @access Private
 */
router.put('/read/:tripId/:packageId', auth, async (req, res) => {
  try {
    const { tripId, packageId } = req.params;
    
    if (!tripId || !packageId || isNaN(tripId) || isNaN(packageId)) {
      return res.status(400).json({
        success: false,
        message: 'ID de voyage et de colis requis et doivent être des nombres'
      });
    }

    await messageService.markMessagesAsRead(
      parseInt(tripId),
      parseInt(packageId),
      req.user.userId
    );
    
    res.json({
      success: true,
      message: 'Messages marqués comme lus'
    });
  } catch (error) {
    console.error('Erreur lors du marquage des messages:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors du marquage des messages',
      error: error.message
    });
  }
});

/**
 * @route GET /api/messages/search
 * @desc Rechercher dans les messages
 * @access Private
 */
router.get('/search', auth, async (req, res) => {
  try {
    const { q: searchTerm, limit = 20 } = req.query;
    
    if (!searchTerm || searchTerm.trim().length < 2) {
      return res.status(400).json({
        success: false,
        message: 'Terme de recherche requis (minimum 2 caractères)'
      });
    }

    const messages = await messageService.searchMessages(
      req.user.userId,
      searchTerm.trim(),
      parseInt(limit)
    );
    
    res.json({
      success: true,
      data: messages,
      count: messages.length,
      searchTerm: searchTerm.trim()
    });
  } catch (error) {
    console.error('Erreur lors de la recherche de messages:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de la recherche de messages',
      error: error.message
    });
  }
});

/**
 * @route POST /api/messages/conversation/create
 * @desc Créer une nouvelle conversation
 * @access Private
 */
router.post('/conversation/create', auth, async (req, res) => {
  try {
    const { tripId, packageId } = req.body;
    
    if (!tripId || !packageId || isNaN(tripId) || isNaN(packageId)) {
      return res.status(400).json({
        success: false,
        message: 'ID de voyage et de colis requis et doivent être des nombres'
      });
    }

    // Vérifier l'accès au voyage et au colis
    const accessQuery = `
      SELECT t.user_id as trip_owner, p.user_id as package_owner,
             t.departure_city, t.destination_city, p.title as package_title
      FROM trips t, packages p
      WHERE t.id = $1 AND p.id = $2
    `;
    const accessResult = await db.query(accessQuery, [tripId, packageId]);
    
    if (accessResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Voyage ou colis non trouvé'
      });
    }

    const { trip_owner, package_owner, departure_city, destination_city, package_title } = accessResult.rows[0];
    const userId = req.user.userId;
    
    // Vérifier que l'utilisateur est soit le propriétaire du voyage, soit du colis
    if (userId !== trip_owner && userId !== package_owner) {
      return res.status(403).json({
        success: false,
        message: 'Accès non autorisé pour créer cette conversation'
      });
    }

    // Créer ou récupérer la conversation
    const conversation = await messageService.getOrCreateConversation(
      parseInt(tripId),
      parseInt(packageId),
      package_owner,
      trip_owner
    );
    
    res.status(201).json({
      success: true,
      message: 'Conversation créée avec succès',
      data: {
        id: conversation.id,
        tripId: conversation.trip_id,
        packageId: conversation.package_id,
        context: {
          route: `${departure_city} → ${destination_city}`,
          packageTitle: package_title
        },
        participants: {
          sender: package_owner,
          traveler: trip_owner
        }
      }
    });
  } catch (error) {
    console.error('Erreur lors de la création de conversation:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de la création de conversation',
      error: error.message
    });
  }
});

/**
 * @route GET /api/messages/stats
 * @desc Obtenir les statistiques de messagerie de l'utilisateur
 * @access Private
 */
router.get('/stats', auth, async (req, res) => {
  try {
    const userId = req.user.userId;
    
    // Statistiques des conversations
    const conversationStatsQuery = `
      SELECT 
        COUNT(*) as total_conversations,
        COUNT(CASE WHEN last_message_at > NOW() - INTERVAL '24 hours' THEN 1 END) as active_today,
        COUNT(CASE WHEN last_message_at > NOW() - INTERVAL '7 days' THEN 1 END) as active_week
      FROM conversations
      WHERE sender_id = $1 OR traveler_id = $1
    `;
    
    // Statistiques des messages
    const messageStatsQuery = `
      SELECT 
        COUNT(*) as total_messages,
        COUNT(CASE WHEN sender_id = $1 THEN 1 END) as sent_messages,
        COUNT(CASE WHEN receiver_id = $1 THEN 1 END) as received_messages,
        COUNT(CASE WHEN receiver_id = $1 AND is_read = FALSE THEN 1 END) as unread_messages,
        COUNT(CASE WHEN message_type != 'text' THEN 1 END) as messages_with_files
      FROM messages
      WHERE sender_id = $1 OR receiver_id = $1
    `;
    
    const [conversationStats, messageStats] = await Promise.all([
      db.query(conversationStatsQuery, [userId]),
      db.query(messageStatsQuery, [userId])
    ]);
    
    res.json({
      success: true,
      data: {
        conversations: {
          total: parseInt(conversationStats.rows[0].total_conversations),
          activeToday: parseInt(conversationStats.rows[0].active_today),
          activeWeek: parseInt(conversationStats.rows[0].active_week)
        },
        messages: {
          total: parseInt(messageStats.rows[0].total_messages),
          sent: parseInt(messageStats.rows[0].sent_messages),
          received: parseInt(messageStats.rows[0].received_messages),
          unread: parseInt(messageStats.rows[0].unread_messages),
          withFiles: parseInt(messageStats.rows[0].messages_with_files)
        }
      }
    });
  } catch (error) {
    console.error('Erreur lors de la récupération des statistiques:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de la récupération des statistiques',
      error: error.message
    });
  }
});

module.exports = router;