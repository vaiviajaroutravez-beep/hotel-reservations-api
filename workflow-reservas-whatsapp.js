// Recanto das Tiribas - WhatsApp Reservation Automation
const axios = require('axios');
const HOSPEDIN_API_URL = process.env.HOSPEDIN_API_URL || 'https://api.hospedin.com.br/v1';
const HOSPEDIN_API_KEY = process.env.HOSPEDIN_API_KEY;
const HOSPEDIN_ACCOUNT_ID = process.env.HOSPEDIN_ACCOUNT_ID;
const ZAPI_API_URL = process.env.ZAPI_API_URL || 'https://api.z-api.io/instances';
const ZAPI_INSTANCE_ID = process.env.ZAPI_INSTANCE_ID;
const ZAPI_API_TOKEN = process.env.ZAPI_API_TOKEN;
const AUTHORIZED_NUMBERS = (process.env.AUTHORIZED_PHONE_NUMBERS || '5513996626898').split(',').map(n => n.trim());
const PORT = process.env.PORT || 3000;
const express = require('express');
const app = express();
app.use(express.json());
app.post('/zapi-reply', async (req, res) => {
  try {
    console.log('📨 Webhook recebido:', JSON.stringify(req.body, null, 2));
    const message = req.body;
    if (!message.messageObject || !message.messageObject.text) {
      console.log('❌ Mensagem sem texto ou formato inválido');
      return res.json({ success: false, error: 'No message text' });
    }
    const senderPhone = message.messageObject.sender?.id || message.messageObject.from;
    const messageText = message.messageObject.text;
    if (!AUTHORIZED_NUMBERS.includes(senderPhone)) {
      console.log(`⚠️ Ignorando msg de número desconhecido: ${senderPhone}`);
      return res.json({ success: false, error: 'Unauthorized number' });
    }
    console.log(`✅ Mensagem de número autorizado: ${senderPhone}`);
    console.log(`📝 Texto: ${messageText}`);
    const result = await processReservation(messageText, senderPhone);
    if (result.success) {
      const obsMessage = result.data.observation ? `\nObservação: ${result.data.observation}` : '';
      await sendWhatsAppMessage(senderPhone, `✅ Reserva confirmada!\n\nHóspede: ${result.data.guestName}\nData Entrada: ${result.data.checkInDate}\nData Saída: ${result.data.checkOutDate}\nAdultos: ${result.data.adults}\nCrianças: ${result.data.children}${obsMessage}\n\nCódigo da reserva: ${result.data.reservationId}`);
      console.log('✅ Resposta enviada via WhatsApp');
    } else {
      await sendWhatsAppMessage(senderPhone, `❌ Erro ao processar reserva:\n${result.error}\n\nFormato correto: reserva: Nome, DD/MM/YYYY, DD/MM/YYYY, CPF, Adultos, Crianças, Email, Telefone, Observação (opcional)`);
      console.log('❌ Erro enviado via WhatsApp');
    }
    return res.json({ success: true, data: result.data });
  } catch (error) {
    console.error('❌ Erro ao processar webhook:', error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
});
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});
async function getHostedinJWT() {
  try {
    console.log('🔐 Obtendo JWT do Hospedin...');
    const response = await axios.post(`${HOSPEDIN_API_URL}/authentication/login`, {
      apiKey: HOSPEDIN_API_KEY,
      accountId: HOSPEDIN_ACCOUNT_ID
    }, { timeout: 10000 });
    const token = response.data.accessToken || response.data.token;
    console.log('✅ JWT obtido com sucesso');
    return token;
  } catch (error) {
    console.error('❌ Erro ao obter JWT:', error.message);
    throw new Error(`Falha na autenticação Hospedin: ${error.message}`);
  }
}
async function createGuest(guestData, jwtToken) {
  try {
    console.log('👤 Criando hóspede no Hospedin...');
    const response = await axios.post(`${HOSPEDIN_API_URL}/guests`, {
      name: guestData.name,
      email: guestData.email,
      phone: guestData.phone,
      nationality: guestData.nationality || 'Brazilian',
      documentNumber: guestData.documentNumber || '',
      birthDate: guestData.birthDate || ''
    }, {
      headers: { Authorization: `Bearer ${jwtToken}` },
      timeout: 10000
    });
    console.log('✅ Hóspede criado:', response.data.id);
    return response.data.id;
  } catch (error) {
    if (error.response?.status === 409) {
      console.log('ℹ️ Hóspede já existe, buscando ID...');
      return await findGuestByEmail(guestData.email, jwtToken);
    }
    console.error('❌ Erro ao criar hóspede:', error.message);
    throw new Error(`Falha ao criar hóspede: ${error.message}`);
  }
}
async function findGuestByEmail(email, jwtToken) {
  try {
    const response = await axios.get(`${HOSPEDIN_API_URL}/guests?email=${encodeURIComponent(email)}`, {
      headers: { Authorization: `Bearer ${jwtToken}` },
      timeout: 10000
    });
    if (response.data && response.data.length > 0) {
      return response.data[0].id;
    }
    return null;
  } catch (error) {
    console.error('❌ Erro ao buscar hóspede:', error.message);
    return null;
  }
}
async function createReservation(reservationData, guestId, jwtToken) {
  try {
    console.log('🏨 Criando reserva no Hospedin...');
    const response = await axios.post(`${HOSPEDIN_API_URL}/reservations`, {
      guestId: guestId,
      checkIn: reservationData.checkInDate,
      checkOut: reservationData.checkOutDate,
      numberOfAdults: reservationData.adults,
      numberOfChildren: reservationData.children,
      totalGuests: reservationData.adults + reservationData.children,
      cpf: reservationData.cpf,
      specialRequests: reservationData.observation || '',
      source: 'whatsapp-zapi'
    }, {
      headers: { Authorization: `Bearer ${jwtToken}` },
      timeout: 10000
    });
    console.log('✅ Reserva criada:', response.data.id);
    return response.data;
  } catch (error) {
    console.error('❌ Erro ao criar reserva:', error.message);
    throw new Error(`Falha ao criar reserva: ${error.message}`);
  }
}
async function sendWhatsAppMessage(phone, message) {
  try {
    console.log(`📤 Enviando mensagem WhatsApp para ${phone}...`);
    const response = await axios.post(`${ZAPI_API_URL}/${ZAPI_INSTANCE_ID}/send-text`, {
      phone: phone,
      message: message
    }, {
      headers: {
        'Client-Token': ZAPI_API_TOKEN,
        'Content-Type': 'application/json'
      },
      timeout: 10000
    });
    console.log('✅ Mensagem enviada com sucesso');
    return response.data;
  } catch (error) {
    console.error('❌ Erro ao enviar mensagem WhatsApp:', error.message);
    return { success: false, error: error.message };
  }
}
function parseReservationMessage(messageText) {
  const regex = /reserva:\s*(.+?),\s*(.+?),\s*(.+?),\s*(.+?),\s*(.+?),\s*(.+?),\s*(.+?),\s*(.+?)(?:,\s*(.+))?$/i;
  const match = messageText.match(regex);
  if (!match) {
    return {
      success: false,
      error: 'Formato inválido. Use: reserva: Nome, DD/MM/YYYY, DD/MM/YYYY, CPF, Adultos, Crianças, Email, Telefone, Observação (opcional)'
    };
  }
  const [, name, checkIn, checkOut, cpf, adults, children, email, phone, observation] = match;
  const checkInDate = parseDate(checkIn.trim());
  const checkOutDate = parseDate(checkOut.trim());
  if (!checkInDate || !checkOutDate) {
    return {
      success: false,
      error: 'Datas inválidas. Use o formato DD/MM/YYYY'
    };
  }
  if (checkOutDate <= checkInDate) {
    return {
      success: false,
      error: 'Data de saída deve ser posterior à data de entrada'
    };
  }
  const cpfClean = cpf.trim().replace(/\D/g, '');
  if (cpfClean.length !== 11) {
    return {
      success: false,
      error: 'CPF inválido. Deve ter 11 dígitos'
    };
  }
  const numAdults = parseInt(adults.trim());
  const numChildren = parseInt(children.trim());
  if (isNaN(numAdults) || numAdults < 1) {
    return {
      success: false,
      error: 'Quantidade de adultos deve ser um número válido (mínimo 1)'
    };
  }
  if (isNaN(numChildren) || numChildren < 0) {
    return {
      success: false,
      error: 'Quantidade de crianças deve ser um número válido (0 ou mais)'
    };
  }
  return {
    success: true,
    data: {
      guestName: name.trim(),
      checkInDate: checkInDate,
      checkOutDate: checkOutDate,
      cpf: cpfClean,
      adults: numAdults,
      children: numChildren,
      email: email.trim(),
      phone: phone.trim(),
      observation: observation ? observation.trim() : ''
    }
  };
}
function parseDate(dateStr) {
  const [day, month, year] = dateStr.split('/');
  if (!day || !month || !year || day.length !== 2 || month.length !== 2 || year.length !== 4) {
    return null;
  }
  const date = new Date(`${year}-${month}-${day}`);
  if (isNaN(date.getTime())) {
    return null;
  }
  return date.toISOString().split('T')[0];
}
async function processReservation(messageText, senderPhone) {
  try {
    const parsedMsg = parseReservationMessage(messageText);
    if (!parsedMsg.success) {
      return parsedMsg;
    }
    const reservationData = parsedMsg.data;
    const jwtToken = await getHostedinJWT();
    const guestId = await createGuest({
      name: reservationData.guestName,
      email: reservationData.email,
      phone: reservationData.phone
    }, jwtToken);
    if (!guestId) {
      return {
        success: false,
        error: 'Não foi possível criar ou localizar o hóspede'
      };
    }
    const reservation = await createReservation(reservationData, guestId, jwtToken);
    return {
      success: true,
      data: {
        reservationId: reservation.id,
        guestName: reservationData.guestName,
        checkInDate: reservationData.checkInDate,
        checkOutDate: reservationData.checkOutDate,
        adults: reservationData.adults,
        children: reservationData.children,
        cpf: reservationData.cpf,
        observation: reservationData.observation
      }
    };
  } catch (error) {
    console.error('❌ Erro ao processar reserva:', error.message);
    return {
      success: false,
      error: error.message
    };
  }
}
app.listen(PORT, () => {
  console.log(`\n🚀 Servidor de Reservas WhatsApp rodando na porta ${PORT}`);
  console.log(`📌 Webhook URL: http://localhost:${PORT}/zapi-reply`);
  console.log(`🏨 Hospedin API: ${HOSPEDIN_API_URL}`);
  console.log(`💬 Z-API Instance: ${ZAPI_INSTANCE_ID}`);
  console.log(`📞 Números autorizados: ${AUTHORIZED_NUMBERS.join(', ')}`);
  console.log('\n✅ Sistema pronto para receber reservas via WhatsApp\n');
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Promise rejection não tratada:', reason);
});
process.on('uncaughtException', (error) => {
  console.error('❌ Exceção não capturada:', error);
});
