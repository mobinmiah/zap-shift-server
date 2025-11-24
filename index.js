const express = require('express')
const cors= require('cors')
const app = express()
require('dotenv').config();
const port = process.env.PORT || 3000

// middle wares
app.use(cors())
app.use(express.json())

app.get('/', (req, res) => {
    res.send('Zap Shift is runnign!')
})

app.listen(port, () => {
    console.log(`Example app listening on port ${port}`)
})