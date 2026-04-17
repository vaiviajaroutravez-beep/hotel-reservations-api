const axios = require('axios');
const express = require('express');
const app = express();
app.use(express.json());

const HOSPEDIN_API_URL = process.env.HOSPEDIN_API_URL || 'https://api.hospedin.com.br/v1';
const HOSPEDIN_API_KEY = process.env.HOSPEDIN_API_KEY;
const HOSPEDIN_ACCOUNT_ID = process.env.HOSPEDIN_ACCOUNT_ID;
const ZAPI_API_URL = process.env.ZAPI_API_URL || 'https://api.z-api.io/instances';
const ZAPI_INSTANCE_ID = process.env.ZAPI_INSTANCE_ID;
const ZAPI_API_TOKEN = process.env.ZAPI_API_TOKEN;
const AUTHORIZED_NUMBERS = (process.env.AUTHORIZED_PHONE_NUMBERS || '5513996626898').split(',').map(n => n.trim());
const PORT = process.env.PORT || 3000;

app.post('/zapi-reply', async (req, res) => {
  try {
    const message = req.body;
    if (!message.messageObject?.text) return res.json({ success: false, error: 'No message text' });
    
    const senderPhone = message.messageObject.sender?.id || message.messageObject.from;
    const messageText = message.messageObject.text;
    
    if (!AUTHORIZED_NUMBERS.includes(senderPhone)) {
      return res.json({ success: false, error: 'Unauthorized number' });
    }
    
    const result = await processReservation(messageText, senderPhone);
    
    if (result.success) {
      const obsMessage = result.data.observation ? `\nObservação: ${result.data.observation}` : '';
      await sendWhatsAppMessage(senderPhone, `✅ Reserva confirmada!\n\nHóspede: ${result.data.guestName}\nData Entrada: ${result.data.checkInDate}\nData Saída: ${result.data.checkOutDate}\nAdultos: ${result.data.adults}\nCrianças: ${result.data.children}${obsMessage}\n\nCódigo: ${result.data.reservationId}`);
    } else {
      await sendWhatsAppMessage(senderPhone, `❌ Erro ao processar reserva:\n${result.error}\n\nFormato: reserva: Nome, DD/MM/YYYY, DD/MM/YYYY, CPF, Adultos, Crianças, Email, Telefone, Observação (opcional)`);
    }
    
    return res.json({ success: true, data: result.data });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

async function getHostedinJWT() {
  const response = await axios.post(`${HOSPEDIN_API_URL}/authentication/login`, { apiKey: HOSPEDIN_API_KEY, accountId: HOSPEDIN_ACCOUNT_ID }, { timeout: 10000 });
  return response.data.accessToken || response.data.token;
}

async function createGuest(guestData, jwtToken) {
  try {
    const response = await axios.post(`${HOSPEDIN_API_URL}/guests`, { name: guestData.name, email: guestData.email, phone: guestData.phone, nationality: 'Brazilian', documentNumber: guestData.documentNumber || '' }, { headers: { Authorization: `Bearer ${jwtToken}` }, timeout: 10000 });
    return response.data.id;
  } catch (error) {
    if (error.response?.status === 409) return await findGuestByEmail(guestData.email, jwtToken);
    throw error;
  }
}

async function findGuestByEmail(email, jwtToken) {
  const response = await axios.get(`${HOSPEDIN_API_URL}/guests?email=${encodeURIComponent(email)}`, { headers: { Authorization: `Bearer ${jwtToken}` }, timeout: 10000 });
  return response.data?.[0]?.id || null;
}

async function createReservation(reservationData, guestId, jwtToken) {
  const response = await axios.post(`${HOSPEDIN_API_URL}/reservations`, { guestId: guestId, checkIn: reservationData.checkInDate, checkOut: reservationData.checkOutDate, numberOfAdults: reservationData.adults, numberOfChildren: reservationData.children, totalGuests: reservationData.adults + reservationData.children, cpf: reservationData.cpf, specialRequests: reservationData.observation || '', source: 'whatsapp-zapi' }, { headers: { Authorization: `Bearer ${jwtToken}` }, timeout: 10000 });
  return response.data;
}

async function sendWhatsAppMessage(phone, message) {
  try {
    await axios.post(`${ZAPI_API_URL}/${ZAPI_INSTANCE_ID}/send-text`, { phone: phone, message: message }, { headers: { 'Client-Token': ZAPI_API_TOKEN, 'Content-Type': 'application/json' }, timeout: 10000 });
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

function parseReservationMessage(messageText) {
  const regex = /reserva:\s*(.+?),\s*(.+?),\s*(.+?),\s*(.+?),\s*(.+?),\s*(.+?),\s*(.+?),\s*(.+?)(?:,\s*(.+))?$/i;
  const match = messageText.match(regex);
  if (!match) return { success: false, error: 'Formato inválido. Use: reserva: Nome, DD/MM/YYYY, DD/MM/YYYY, CPF, Adultos, Crianças, Email, Telefone, Observação (opcional)' };
  
  const [, name, checkIn, checkOut, cpf, adults, children, email, phone, observation] = match;
  const checkInDate = parseDate(checkIn.trim());
  const checkOutDate = parseDate(checkOut.trim());
  
  if (!checkInDate || !checkOutDate) return { success: false, error: 'Datas inválidas. Use formato DD/MM/YYYY' };
  
  const adultsNum = parseInt(adults.trim());
  const childrenNum = parseInt(children.trim());
  if (isNaN(adultsNum) || adultsNum < 1) return { success: false, error: 'Mínimo 1 adulto' };
  if (isNaN(childrenNum) || childrenNum < 0) return { success: false, error: 'Número de crianças inválido' };
  if (cpf.trim().length !== 11) return { success: false, error: 'CPF deve ter 11 dígitos' };
  
  return { success: true, guestName: name.trim(), checkInDate: checkInDate, checkOutDate: checkOutDate, cpf: cpf.trim(), adults: adultsNum, children: childrenNum, email: email.trim(), phone: phone.trim(), observation: observation?.trim() || '' };
}

function parseDate(dateStr) {
  const [day, month, year] = dateStr.split('/');
  if (!day || !month || !year) return null;
  const d = parseInt(day), m = parseInt(month), y = parseInt(year);
  if (d < 1 || d > 31 || m < 1 || m > 12 || y < 2024) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

async function processReservation(messageText, senderPhone) {
  try {
    const parsed = parseReservationMessage(messageText);
    if (!parsed.success) return { success: false, error: parsed.error };
    
    const jwtToken = await getHostedinJWT();
    const guestId = await createGuest({ name: parsed.guestName, email: parsed.email, phone: parsed.phone, documentNumber: parsed.cpf }, jwtToken);
    const reservation = await createReservation(parsed, guestId, jwtToken);
    
    return { success: true, data: { reservationId: reservation.id, guestName: parsed.guestName, checkInDate: parsed.checkInDate, checkOutDate: parsed.checkOutDate, adults: parsed.adults, children: parsed.children, cpf: parsed.cpf, observation: parsed.observation } };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
});
