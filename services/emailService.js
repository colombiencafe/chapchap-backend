const nodemailer = require('nodemailer');
const crypto = require('crypto');
const db = require('../config/database');

// Configuration du transporteur email
const createTransporter = () => {
  // En développement, utiliser un service de test comme Ethereal
  if (process.env.NODE_ENV === 'development') {
    return nodemailer.createTransporter({
      host: 'smtp.ethereal.email',
      port: 587,
      auth: {
        user: process.env.EMAIL_USER || 'ethereal.user@ethereal.email',
        pass: process.env.EMAIL_PASS || 'ethereal.pass'
      }
    });
  }
  
  // En production, utiliser un vrai service SMTP
  return nodemailer.createTransporter({
    host: process.env.SMTP_HOST,
    port: process.env.SMTP_PORT || 587,
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS
    }
  });
};

// Générer un token de vérification
const generateVerificationToken = () => {
  return crypto.randomBytes(32).toString('hex');
};

// Envoyer un email de vérification
const sendVerificationEmail = async (email, firstName, token) => {
  try {
    const transporter = createTransporter();
    const verificationUrl = `${process.env.CLIENT_URL}/verify-email?token=${token}`;
    
    const mailOptions = {
      from: `"Chapchap" <${process.env.EMAIL_FROM || 'noreply@chapchap.com'}>`,
      to: email,
      subject: 'Vérifiez votre adresse email - Chapchap',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; text-align: center;">
            <h1 style="color: white; margin: 0; font-size: 28px;">Chapchap</h1>
            <p style="color: white; margin: 10px 0 0 0; opacity: 0.9;">Transport de colis Canada-Afrique</p>
          </div>
          
          <div style="padding: 40px 30px; background: white;">
            <h2 style="color: #333; margin-bottom: 20px;">Bonjour ${firstName} ! 👋</h2>
            
            <p style="color: #666; line-height: 1.6; margin-bottom: 25px;">
              Bienvenue sur Chapchap ! Pour finaliser votre inscription et commencer à utiliser notre plateforme, 
              veuillez vérifier votre adresse email en cliquant sur le bouton ci-dessous.
            </p>
            
            <div style="text-align: center; margin: 35px 0;">
              <a href="${verificationUrl}" 
                 style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); 
                        color: white; 
                        padding: 15px 30px; 
                        text-decoration: none; 
                        border-radius: 25px; 
                        font-weight: bold;
                        display: inline-block;
                        box-shadow: 0 4px 15px rgba(102, 126, 234, 0.3);">
                ✅ Vérifier mon email
              </a>
            </div>
            
            <p style="color: #999; font-size: 14px; margin-top: 30px;">
              Si le bouton ne fonctionne pas, copiez et collez ce lien dans votre navigateur :<br>
              <span style="word-break: break-all;">${verificationUrl}</span>
            </p>
            
            <p style="color: #999; font-size: 14px; margin-top: 20px;">
              Ce lien expire dans 24 heures. Si vous n'avez pas créé de compte, ignorez cet email.
            </p>
          </div>
          
          <div style="background: #f8f9fa; padding: 20px; text-align: center; border-top: 1px solid #eee;">
            <p style="color: #999; font-size: 12px; margin: 0;">
              © 2024 Chapchap. Tous droits réservés.
            </p>
          </div>
        </div>
      `
    };
    
    const info = await transporter.sendMail(mailOptions);
    console.log('📧 Email de vérification envoyé:', info.messageId);
    
    // En développement, afficher l'URL de prévisualisation
    if (process.env.NODE_ENV === 'development') {
      console.log('🔗 Prévisualisation:', nodemailer.getTestMessageUrl(info));
    }
    
    return { success: true, messageId: info.messageId };
    
  } catch (error) {
    console.error('❌ Erreur envoi email de vérification:', error);
    throw new Error('Erreur lors de l\'envoi de l\'email de vérification');
  }
};

// Envoyer un email de récupération de mot de passe
const sendPasswordResetEmail = async (email, firstName, token) => {
  try {
    const transporter = createTransporter();
    const resetUrl = `${process.env.CLIENT_URL}/reset-password?token=${token}`;
    
    const mailOptions = {
      from: `"Chapchap" <${process.env.EMAIL_FROM || 'noreply@chapchap.com'}>`,
      to: email,
      subject: 'Réinitialisation de votre mot de passe - Chapchap',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; text-align: center;">
            <h1 style="color: white; margin: 0; font-size: 28px;">Chapchap</h1>
            <p style="color: white; margin: 10px 0 0 0; opacity: 0.9;">Transport de colis Canada-Afrique</p>
          </div>
          
          <div style="padding: 40px 30px; background: white;">
            <h2 style="color: #333; margin-bottom: 20px;">Bonjour ${firstName} ! 🔐</h2>
            
            <p style="color: #666; line-height: 1.6; margin-bottom: 25px;">
              Vous avez demandé la réinitialisation de votre mot de passe. 
              Cliquez sur le bouton ci-dessous pour créer un nouveau mot de passe.
            </p>
            
            <div style="text-align: center; margin: 35px 0;">
              <a href="${resetUrl}" 
                 style="background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%); 
                        color: white; 
                        padding: 15px 30px; 
                        text-decoration: none; 
                        border-radius: 25px; 
                        font-weight: bold;
                        display: inline-block;
                        box-shadow: 0 4px 15px rgba(245, 87, 108, 0.3);">
                🔑 Réinitialiser mon mot de passe
              </a>
            </div>
            
            <p style="color: #999; font-size: 14px; margin-top: 30px;">
              Si le bouton ne fonctionne pas, copiez et collez ce lien dans votre navigateur :<br>
              <span style="word-break: break-all;">${resetUrl}</span>
            </p>
            
            <p style="color: #999; font-size: 14px; margin-top: 20px;">
              Ce lien expire dans 1 heure. Si vous n'avez pas demandé cette réinitialisation, ignorez cet email.
            </p>
            
            <div style="background: #fff3cd; border: 1px solid #ffeaa7; border-radius: 8px; padding: 15px; margin-top: 25px;">
              <p style="color: #856404; margin: 0; font-size: 14px;">
                <strong>⚠️ Sécurité :</strong> Ne partagez jamais ce lien avec personne. 
                Notre équipe ne vous demandera jamais votre mot de passe par email.
              </p>
            </div>
          </div>
          
          <div style="background: #f8f9fa; padding: 20px; text-align: center; border-top: 1px solid #eee;">
            <p style="color: #999; font-size: 12px; margin: 0;">
              © 2024 Chapchap. Tous droits réservés.
            </p>
          </div>
        </div>
      `
    };
    
    const info = await transporter.sendMail(mailOptions);
    console.log('📧 Email de récupération envoyé:', info.messageId);
    
    // En développement, afficher l'URL de prévisualisation
    if (process.env.NODE_ENV === 'development') {
      console.log('🔗 Prévisualisation:', nodemailer.getTestMessageUrl(info));
    }
    
    return { success: true, messageId: info.messageId };
    
  } catch (error) {
    console.error('❌ Erreur envoi email de récupération:', error);
    throw new Error('Erreur lors de l\'envoi de l\'email de récupération');
  }
};

// Stocker un token de vérification en base
const storeVerificationToken = async (userId, token, type = 'email_verification') => {
  try {
    const expiresAt = new Date();
    if (type === 'email_verification') {
      expiresAt.setHours(expiresAt.getHours() + 24); // 24h pour vérification email
    } else if (type === 'password_reset') {
      expiresAt.setHours(expiresAt.getHours() + 1); // 1h pour reset password
    }
    
    await db.query(
      `INSERT INTO verification_tokens (user_id, token, type, expires_at) 
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, type) 
       DO UPDATE SET token = $2, expires_at = $4, created_at = NOW()`,
      [userId, token, type, expiresAt]
    );
    
    return { success: true };
  } catch (error) {
    console.error('❌ Erreur stockage token:', error);
    throw new Error('Erreur lors du stockage du token');
  }
};

// Vérifier un token
const verifyToken = async (token, type = 'email_verification') => {
  try {
    const result = await db.query(
      `SELECT vt.*, u.id as user_id, u.email, u.first_name 
       FROM verification_tokens vt
       JOIN users u ON vt.user_id = u.id
       WHERE vt.token = $1 AND vt.type = $2 AND vt.expires_at > NOW()`,
      [token, type]
    );
    
    if (result.rows.length === 0) {
      return { valid: false, error: 'Token invalide ou expiré' };
    }
    
    return { valid: true, user: result.rows[0] };
  } catch (error) {
    console.error('❌ Erreur vérification token:', error);
    throw new Error('Erreur lors de la vérification du token');
  }
};

// Supprimer un token après utilisation
const deleteToken = async (token, type) => {
  try {
    await db.query(
      'DELETE FROM verification_tokens WHERE token = $1 AND type = $2',
      [token, type]
    );
  } catch (error) {
    console.error('❌ Erreur suppression token:', error);
  }
};

module.exports = {
  generateVerificationToken,
  sendVerificationEmail,
  sendPasswordResetEmail,
  storeVerificationToken,
  verifyToken,
  deleteToken
};