#!/usr/bin/env python3
"""
Pipedrive Sync - Exporta datos a JSON para tu dashboard
Carga API Key automáticamente desde .env o variables de Render
"""

import os
import json
import logging
from datetime import datetime
from dotenv import load_dotenv
import requests

load_dotenv()

PIPEDRIVE_API_KEY = os.getenv('PIPEDRIVE_API_KEY')
if not PIPEDRIVE_API_KEY:
    print("❌ ERROR: PIPEDRIVE_API_KEY no configurada")
    print("Render: Settings → Environment Variables → PIPEDRIVE_API_KEY")
    exit(1)

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(message)s')
logger = logging.getLogger(__name__)

class PipedriveSync:
    def __init__(self, api_key):
        self.api_key = api_key
        self.url = 'https://api.pipedrive.com/v1'
        logger.info("✓ Conectado a Pipedrive")
    
    def get(self, endpoint, **kwargs):
        """Request GET"""
        params = kwargs
        params['api_token'] = self.api_key
        r = requests.get(f"{self.url}{endpoint}", params=params, timeout=15)
        return r.json() if r.ok else None
    
    def sync_deals(self):
        """Extrae deals"""
        logger.info("📥 Deals...")
        deals = []
        start = 0
        while True:
            data = self.get('/deals', start=start, limit=500)
            if not data or not data.get('data'):
                break
            deals.extend(data['data'])
            if not data.get('additional_data', {}).get('pagination', {}).get('more_items_in_collection'):
                break
            start = data['additional_data']['pagination'].get('next_start')
        return deals
    
    def sync_persons(self):
        """Extrae personas"""
        logger.info("📥 Personas...")
        persons = []
        start = 0
        while True:
            data = self.get('/persons', start=start, limit=500)
            if not data or not data.get('data'):
                break
            persons.extend(data['data'])
            if not data.get('additional_data', {}).get('pagination', {}).get('more_items_in_collection'):
                break
            start = data['additional_data']['pagination'].get('next_start')
        return persons
    
    def sync_organizations(self):
        """Extrae organizaciones"""
        logger.info("📥 Organizaciones...")
        orgs = []
        start = 0
        while True:
            data = self.get('/organizations', start=start, limit=500)
            if not data or not data.get('data'):
                break
            orgs.extend(data['data'])
            if not data.get('additional_data', {}).get('pagination', {}).get('more_items_in_collection'):
                break
            start = data['additional_data']['pagination'].get('next_start')
        return orgs

def main():
    logger.info("="*60)
    logger.info(f"SYNC PIPEDRIVE - {datetime.now().isoformat()}")
    logger.info("="*60)
    
    try:
        sync = PipedriveSync(PIPEDRIVE_API_KEY)
        
        deals = sync.sync_deals()
        persons = sync.sync_persons()
        orgs = sync.sync_organizations()
        
        data = {
            'timestamp': datetime.now().isoformat(),
            'deals': deals,
            'persons': persons,
            'organizations': orgs,
            'summary': {
                'total_deals': len(deals),
                'total_persons': len(persons),
                'total_organizations': len(orgs),
                'total_value': sum(d.get('value', 0) or 0 for d in deals)
            }
        }
        
        output = os.getenv('OUTPUT_FILE', '/tmp/pipedrive_data.json')
        with open(output, 'w') as f:
            json.dump(data, f, indent=2, default=str)
        
        logger.info("✓ SYNC COMPLETADO")
        logger.info(f"  • Deals: {len(deals)}")
        logger.info(f"  • Personas: {len(persons)}")
        logger.info(f"  • Organizaciones: {len(orgs)}")
        logger.info(f"  • Archivo: {output}")
        logger.info("="*60)
        return True
    
    except Exception as e:
        logger.error(f"✗ Error: {e}")
        return False

if __name__ == '__main__':
    main()
