const db = require('../config/database');
const path = require('path');
const fs = require('fs').promises;

/**
 * Service de messagerie pour ChapChap
 * Gère les conversations, messages et fichiers attachés
 */

/**
 * Créer ou récupérer une conversation
 * @param {number} tripId - ID du voyage
 * @param {number} packageId - ID du colis
 * @param {number} senderId - ID de l'expéditeur
 * @param {number} travelerId - ID du voyageur
 * @returns {Object} Conversation
 */
const getOrCreateConversation = async (tripId, packageId, senderId, travelerId) => {
  try {
    // Vérifier si la conversation existe déjà
    const existingQuery = `
      SELECT * FROM conversations 
      WHERE trip_id = $1 AND package_id = $2 AND sender_id = $3 AND traveler_id = $4
    `;
    const existingResult = await db.query(existingQuery, [tripId, packageId, senderId, travelerId]);

    if (existingResult.rows.length > 0) {
      return existingResult.rows[0];
    }

    // Créer une nouvelle conversation
    const createQuery = `
      INSERT INTO conversations (trip_id, package_id, sender_id, traveler_id)
      VALUES ($1, $2, $3, $4)
      RETURNING *
    `;
    const createResult = await db.query(createQuery, [tripId, packageId, senderId, travelerId]);
    return createResult.rows[0];

  } catch (error) {
    console.error('Erreur lors de la création/récupération de conversation:', error);
    throw error;
  }
};

/**
 * Envoyer un message
 * @param {Object} messageData - Données du message
 * @returns {Object} Message créé
 */
const sendMessage = async (messageData) => {
  try {
    const {
      senderId,
      receiverId,
      content,
      messageType = 'text',
      tripId,
      packageId,
      attachmentPath,
      attachmentName,
      attachmentSize,
      attachmentType
    } = messageData;

    // Créer le message
    const messageQuery = `
      INSERT INTO messages (
        sender_id, receiver_id, content, message_type, trip_id, package_id,
        attachment_path, attachment_name, attachment_size, attachment_type
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING *
    `;
    
    const messageResult = await db.query(messageQuery, [
      senderId, receiverId, content, messageType, tripId, packageId,
      attachmentPath, attachmentName, attachmentSize, attachmentType
    ]);

    const message = messageResult.rows[0];

    // Mettre à jour la conversation
    if (tripId && packageId) {
      const updateConversationQuery = `
        UPDATE conversations 
        SET last_message_id = $1, last_message_at = CURRENT_TIMESTAMP
        WHERE trip_id = $2 AND package_id = $3 AND 
              ((sender_id = $4 AND traveler_id = $5) OR (sender_id = $5 AND traveler_id = $4))
      `;
      await db.query(updateConversationQuery, [message.id, tripId, packageId, senderId, receiverId]);
    }

    // Récupérer le message avec les informations de l'expéditeur
    const fullMessageQuery = `
      SELECT m.*, 
             u.first_name as sender_first_name, 
             u.last_name as sender_last_name,
             u.profile_picture as sender_profile_picture
      FROM messages m
      JOIN users u ON m.sender_id = u.id
      WHERE m.id = $1
    `;
    const fullMessageResult = await db.query(fullMessageQuery, [message.id]);
    
    return fullMessageResult.rows[0];

  } catch (error) {
    console.error('Erreur lors de l\'envoi du message:', error);
    throw error;
  }
};

/**
 * Récupérer les messages d'une conversation
 * @param {number} tripId - ID du voyage
 * @param {number} packageId - ID du colis
 * @param {number} userId - ID de l'utilisateur
 * @param {number} page - Page de résultats
 * @param {number} limit - Limite de résultats
 * @returns {Object} Messages avec pagination
 */
const getConversationMessages = async (tripId, packageId, userId, page = 1, limit = 50) => {
  try {
    const offset = (page - 1) * limit;

    // Vérifier que l'utilisateur fait partie de la conversation
    const conversationQuery = `
      SELECT * FROM conversations 
      WHERE trip_id = $1 AND package_id = $2 AND (sender_id = $3 OR traveler_id = $3)
    `;
    const conversationResult = await db.query(conversationQuery, [tripId, packageId, userId]);

    if (conversationResult.rows.length === 0) {
      throw new Error('Conversation non trouvée ou accès non autorisé');
    }

    const conversation = conversationResult.rows[0];

    // Récupérer les messages
    const messagesQuery = `
      SELECT m.*,
             s.first_name as sender_first_name,
             s.last_name as sender_last_name,
             s.profile_picture as sender_profile_picture,
             r.first_name as receiver_first_name,
             r.last_name as receiver_last_name
      FROM messages m
      JOIN users s ON m.sender_id = s.id
      JOIN users r ON m.receiver_id = r.id
      WHERE m.trip_id = $1 AND m.package_id = $2
      AND (m.sender_id = $3 OR m.receiver_id = $3)
      ORDER BY m.created_at DESC
      LIMIT $4 OFFSET $5
    `;
    
    const messagesResult = await db.query(messagesQuery, [tripId, packageId, userId, limit, offset]);

    // Compter le total de messages
    const countQuery = `
      SELECT COUNT(*) as total
      FROM messages m
      WHERE m.trip_id = $1 AND m.package_id = $2
      AND (m.sender_id = $3 OR m.receiver_id = $3)
    `;
    const countResult = await db.query(countQuery, [tripId, packageId, userId]);
    const total = parseInt(countResult.rows[0].total);

    const messages = messagesResult.rows.map(msg => ({
      id: msg.id,
      content: msg.content,
      messageType: msg.message_type,
      sender: {
        id: msg.sender_id,
        firstName: msg.sender_first_name,
        lastName: msg.sender_last_name,
        profilePicture: msg.sender_profile_picture
      },
      receiver: {
        id: msg.receiver_id,
        firstName: msg.receiver_first_name,
        lastName: msg.receiver_last_name
      },
      attachment: msg.attachment_path ? {
        path: msg.attachment_path,
        name: msg.attachment_name,
        size: msg.attachment_size,
        type: msg.attachment_type
      } : null,
      isRead: msg.is_read,
      createdAt: msg.created_at,
      isOwn: msg.sender_id === userId
    }));

    return {
      conversation: {
        id: conversation.id,
        tripId: conversation.trip_id,
        packageId: conversation.package_id,
        senderId: conversation.sender_id,
        travelerId: conversation.traveler_id,
        lastMessageAt: conversation.last_message_at
      },
      messages: messages.reverse(), // Inverser pour avoir les plus anciens en premier
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        totalPages: Math.ceil(total / limit)
      }
    };

  } catch (error) {
    console.error('Erreur lors de la récupération des messages:', error);
    throw error;
  }
};

/**
 * Récupérer toutes les conversations d'un utilisateur
 * @param {number} userId - ID de l'utilisateur
 * @returns {Array} Liste des conversations
 */
const getUserConversations = async (userId) => {
  try {
    const query = `
      SELECT c.*,
             t.departure_country, t.departure_city, t.destination_country, t.destination_city,
             t.departure_date, t.arrival_date,
             p.title as package_title, p.weight as package_weight,
             sender.first_name as sender_first_name, sender.last_name as sender_last_name,
             sender.profile_picture as sender_profile_picture,
             traveler.first_name as traveler_first_name, traveler.last_name as traveler_last_name,
             traveler.profile_picture as traveler_profile_picture,
             lm.content as last_message_content, lm.message_type as last_message_type,
             lm.created_at as last_message_created_at,
             -- Compter les messages non lus
             (
               SELECT COUNT(*) 
               FROM messages m 
               WHERE m.trip_id = c.trip_id AND m.package_id = c.package_id 
               AND m.receiver_id = $1 AND m.is_read = FALSE
             ) as unread_count
      FROM conversations c
      JOIN trips t ON c.trip_id = t.id
      JOIN packages p ON c.package_id = p.id
      JOIN users sender ON c.sender_id = sender.id
      JOIN users traveler ON c.traveler_id = traveler.id
      LEFT JOIN messages lm ON c.last_message_id = lm.id
      WHERE c.sender_id = $1 OR c.traveler_id = $1
      ORDER BY c.last_message_at DESC
    `;
    
    const result = await db.query(query, [userId]);
    
    return result.rows.map(conv => {
      const otherUser = conv.sender_id === userId ? {
        id: conv.traveler_id,
        firstName: conv.traveler_first_name,
        lastName: conv.traveler_last_name,
        profilePicture: conv.traveler_profile_picture,
        role: 'traveler'
      } : {
        id: conv.sender_id,
        firstName: conv.sender_first_name,
        lastName: conv.sender_last_name,
        profilePicture: conv.sender_profile_picture,
        role: 'sender'
      };

      return {
        id: conv.id,
        trip: {
          id: conv.trip_id,
          route: `${conv.departure_city}, ${conv.departure_country} → ${conv.destination_city}, ${conv.destination_country}`,
          departureDate: conv.departure_date,
          arrivalDate: conv.arrival_date
        },
        package: {
          id: conv.package_id,
          title: conv.package_title,
          weight: parseFloat(conv.package_weight)
        },
        otherUser,
        lastMessage: conv.last_message_content ? {
          content: conv.last_message_content,
          type: conv.last_message_type,
          createdAt: conv.last_message_created_at
        } : null,
        unreadCount: parseInt(conv.unread_count),
        lastMessageAt: conv.last_message_at
      };
    });

  } catch (error) {
    console.error('Erreur lors de la récupération des conversations:', error);
    throw error;
  }
};

/**
 * Marquer les messages comme lus
 * @param {number} tripId - ID du voyage
 * @param {number} packageId - ID du colis
 * @param {number} userId - ID de l'utilisateur
 * @returns {boolean} Succès
 */
const markMessagesAsRead = async (tripId, packageId, userId) => {
  try {
    const query = `
      UPDATE messages 
      SET is_read = TRUE, updated_at = CURRENT_TIMESTAMP
      WHERE trip_id = $1 AND package_id = $2 AND receiver_id = $3 AND is_read = FALSE
    `;
    
    await db.query(query, [tripId, packageId, userId]);
    return true;

  } catch (error) {
    console.error('Erreur lors du marquage des messages comme lus:', error);
    throw error;
  }
};

/**
 * Supprimer un message (soft delete)
 * @param {number} messageId - ID du message
 * @param {number} userId - ID de l'utilisateur
 * @returns {boolean} Succès
 */
const deleteMessage = async (messageId, userId) => {
  try {
    // Vérifier que l'utilisateur est l'expéditeur du message
    const checkQuery = 'SELECT * FROM messages WHERE id = $1 AND sender_id = $2';
    const checkResult = await db.query(checkQuery, [messageId, userId]);
    
    if (checkResult.rows.length === 0) {
      throw new Error('Message non trouvé ou non autorisé');
    }

    // Marquer comme supprimé (soft delete)
    const deleteQuery = `
      UPDATE messages 
      SET content = '[Message supprimé]', message_type = 'deleted', updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
    `;
    
    await db.query(deleteQuery, [messageId]);
    return true;

  } catch (error) {
    console.error('Erreur lors de la suppression du message:', error);
    throw error;
  }
};

/**
 * Rechercher dans les messages
 * @param {number} userId - ID de l'utilisateur
 * @param {string} searchTerm - Terme de recherche
 * @param {number} limit - Limite de résultats
 * @returns {Array} Messages trouvés
 */
const searchMessages = async (userId, searchTerm, limit = 20) => {
  try {
    const query = `
      SELECT m.*,
             s.first_name as sender_first_name, s.last_name as sender_last_name,
             r.first_name as receiver_first_name, r.last_name as receiver_last_name,
             t.departure_city, t.destination_city,
             p.title as package_title
      FROM messages m
      JOIN users s ON m.sender_id = s.id
      JOIN users r ON m.receiver_id = r.id
      JOIN trips t ON m.trip_id = t.id
      JOIN packages p ON m.package_id = p.id
      WHERE (m.sender_id = $1 OR m.receiver_id = $1)
      AND m.content ILIKE $2
      AND m.message_type != 'deleted'
      ORDER BY m.created_at DESC
      LIMIT $3
    `;
    
    const result = await db.query(query, [userId, `%${searchTerm}%`, limit]);
    
    return result.rows.map(msg => ({
      id: msg.id,
      content: msg.content,
      messageType: msg.message_type,
      sender: {
        id: msg.sender_id,
        firstName: msg.sender_first_name,
        lastName: msg.sender_last_name
      },
      receiver: {
        id: msg.receiver_id,
        firstName: msg.receiver_first_name,
        lastName: msg.receiver_last_name
      },
      context: {
        tripRoute: `${msg.departure_city} → ${msg.destination_city}`,
        packageTitle: msg.package_title
      },
      createdAt: msg.created_at,
      isOwn: msg.sender_id === userId
    }));

  } catch (error) {
    console.error('Erreur lors de la recherche de messages:', error);
    throw error;
  }
};

module.exports = {
  getOrCreateConversation,
  sendMessage,
  getConversationMessages,
  getUserConversations,
  markMessagesAsRead,
  deleteMessage,
  searchMessages
};