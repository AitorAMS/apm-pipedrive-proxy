#!/usr/bin/env python3
"""
HubSpot Sync - Métricas correctas del dashboard
✓ New Leads (por semana ISO)
✓ Locations Signed (por semana ISO)
✓ Deals Won/Lost (por mes)
✓ Win Rate
✓ Sales Cycle
✓ Closed Lost Reasons
✓ Stage Funnel
"""

import os
import json
import logging
from datetime import datetime
from dotenv import load_dotenv
import requests
from dateutil import parser as date_parser
from collections import defaultdict

load_dotenv()

HUBSPOT_API_KEY = os.getenv('HUBSPOT_API_KEY')
if not HUBSPOT_API_KEY:
    print("❌ ERROR: HUBSPOT_API_KEY no configurada")
    exit(1)

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(message)s')
logger = logging.getLogger(__name__)

class HubSpotDashboardMetrics:
    def __init__(self, api_key):
        self.api_key = api_key
        self.url = 'https://api.hubapi.com/crm/v3/objects'
        self.headers = {
            'Authorization': f'Bearer {api_key}',
            'Content-Type': 'application/json'
        }
        logger.info("✓ Conectado a HubSpot")
    
    def get(self, endpoint, **kwargs):
        """Request GET con paginación"""
        try:
            params = kwargs
            r = requests.get(f"{self.url}{endpoint}", headers=self.headers, params=params, timeout=15)
            return r.json() if r.ok else None
        except Exception as e:
            logger.error(f"Error en {endpoint}: {e}")
            return None
    
    def parse_date(self, date_str):
        """Convierte string/timestamp a datetime"""
        if not date_str:
            return None
        try:
            if isinstance(date_str, int):
                return datetime.fromtimestamp(date_str / 1000)
            else:
                return date_parser.parse(str(date_str))
        except:
            return None
    
    def get_iso_week(self, date_obj):
        """Devuelve ISO week number"""
        if not date_obj:
            return None
        return date_obj.isocalendar()[1]
    
    def get_month(self, date_obj):
        """Devuelve mes"""
        if not date_obj:
            return None
        return date_obj.month
    
    def get_year(self, date_obj):
        """Devuelve año"""
        if not date_obj:
            return None
        return date_obj.year
    
    def get_deals(self):
        """Extrae TODOS los deals con campos necesarios"""
        logger.info("📥 Extrayendo Deals...")
        deals = []
        after = None
        
        properties = [
            'dealname',
            'dealstage',
            'amount',
            'closedate',
            'hs_createdate',
            'hubspot_owner_id',
            'closed_lost_reason',
            'ib_net__no_locations',
            'confirmed_launch_date'
        ]
        
        while True:
            params = {
                'limit': 100,
                'properties': properties
            }
            if after:
                params['after'] = after
            
            data = self.get('/deals', **params)
            if not data or not data.get('results'):
                break
            
            for deal in data['results']:
                props = deal.get('properties', {})
                deal_dict = {
                    'id': deal.get('id'),
                    'name': props.get('dealname', ''),
                    'stage': props.get('dealstage', ''),
                    'amount': float(props.get('amount', 0) or 0),
                    'closedate': props.get('closedate'),
                    'createdate': props.get('hs_createdate'),
                    'owner_id': props.get('hubspot_owner_id'),
                    'lost_reason': props.get('closed_lost_reason', ''),
                    'locations': int(props.get('ib_net__no_locations', 0) or 0),
                    'contract_signed_date': props.get('confirmed_launch_date')
                }
                deals.append(deal_dict)
            
            paging = data.get('paging', {})
            after = paging.get('next', {}).get('after')
            
            if not after:
                break
        
        logger.info(f"✓ {len(deals)} Deals extraídos")
        return deals
    
    def calculate_metrics(self, deals):
        """Calcula todas las métricas"""
        logger.info("📊 Calculando métricas...")
        
        # Estructuras para agrupar datos
        new_leads_by_week = defaultdict(int)  # W5-2026: 45
        locations_by_week = defaultdict(int)  # W5-2026: 12
        deals_won_by_month = defaultdict(int)  # Feb-2026: 43
        deals_lost_by_month = defaultdict(int)  # Feb-2026: 454
        stage_funnel = defaultdict(int)  # "Closed Won": 408
        lost_reasons = defaultdict(int)  # "Network Design Rejected": 125
        sales_cycles_by_month = defaultdict(list)  # Feb-2026: [24, 23, 21, ...]
        
        # Procesar cada deal
        for deal in deals:
            # ===== NEW LEADS: por semana ISO de creación =====
            create_date = self.parse_date(deal['createdate'])
            if create_date:
                week = self.get_iso_week(create_date)
                year = self.get_year(create_date)
                if week and year:
                    week_key = f"W{week}-{year}"
                    new_leads_by_week[week_key] += 1
            
            # ===== LOCATIONS SIGNED: por semana ISO de firma (confirmed_launch_date) =====
            contract_date = self.parse_date(deal['contract_signed_date'])
            if contract_date and deal['stage'] == 'Closed Won':
                week = self.get_iso_week(contract_date)
                year = self.get_year(contract_date)
                if week and year:
                    week_key = f"W{week}-{year}"
                    locations_by_week[week_key] += deal['locations']
            
            # ===== DEALS WON/LOST: por mes de cierre =====
            close_date = self.parse_date(deal['closedate'])
            if close_date:
                month = self.get_month(close_date)
                year = self.get_year(close_date)
                if month and year:
                    month_key = f"M{month:02d}-{year}"
                    
                    if deal['stage'] == 'Closed Won':
                        deals_won_by_month[month_key] += 1
                        
                        # SALES CYCLE: solo para deals won
                        if create_date:
                            days = (close_date - create_date).days
                            sales_cycles_by_month[month_key].append(days)
                    
                    elif deal['stage'] == 'Closed Lost':
                        deals_lost_by_month[month_key] += 1
            
            # ===== STAGE FUNNEL: por etapa =====
            stage_funnel[deal['stage']] += 1
            
            # ===== CLOSED LOST REASONS =====
            if deal['stage'] == 'Closed Lost' and deal['lost_reason']:
                lost_reasons[deal['lost_reason']] += 1
        
        # Calcular promedios de sales cycle
        avg_sales_cycle_by_month = {}
        for month_key, cycles in sales_cycles_by_month.items():
            if cycles:
                avg_sales_cycle_by_month[month_key] = round(sum(cycles) / len(cycles), 1)
        
        # Calcular win rates por mes
        win_rates = {}
        for month_key in set(list(deals_won_by_month.keys()) + list(deals_lost_by_month.keys())):
            won = deals_won_by_month.get(month_key, 0)
            lost = deals_lost_by_month.get(month_key, 0)
            total = won + lost
            if total > 0:
                win_rates[month_key] = round((won / total * 100), 2)
        
        # Crear salida
        metrics = {
            'timestamp': datetime.now().isoformat(),
            'summary': {
                'total_deals': len(deals),
                'total_deals_won': sum(deals_won_by_month.values()),
                'total_deals_lost': sum(deals_lost_by_month.values()),
                'overall_win_rate': round(
                    (sum(deals_won_by_month.values()) / 
                     (sum(deals_won_by_month.values()) + sum(deals_lost_by_month.values())) * 100)
                    if (sum(deals_won_by_month.values()) + sum(deals_lost_by_month.values())) > 0 else 0, 2)
            },
            'by_week': {
                'new_leads': dict(sorted(new_leads_by_week.items())),
                'locations_signed': dict(sorted(locations_by_week.items()))
            },
            'by_month': {
                'deals_won': dict(sorted(deals_won_by_month.items())),
                'deals_lost': dict(sorted(deals_lost_by_month.items())),
                'win_rate': dict(sorted(win_rates.items())),
                'avg_sales_cycle': dict(sorted(avg_sales_cycle_by_month.items()))
            },
            'stage_funnel': dict(sorted(stage_funnel.items(), key=lambda x: x[1], reverse=True)),
            'closed_lost_reasons': dict(sorted(lost_reasons.items(), key=lambda x: x[1], reverse=True)),
            'note': 'Todas las métricas calculadas desde HubSpot API'
        }
        
        return metrics

def main():
    logger.info("="*60)
    logger.info(f"HUBSPOT DASHBOARD METRICS - {datetime.now().isoformat()}")
    logger.info("="*60)
    
    try:
        sync = HubSpotDashboardMetrics(HUBSPOT_API_KEY)
        
        # Extraer deals
        deals = sync.get_deals()
        
        # Calcular métricas
        data = sync.calculate_metrics(deals)
        
        # Guardar
        output = os.getenv('OUTPUT_FILE', '/tmp/hubspot_data.json')
        with open(output, 'w') as f:
            json.dump(data, f, default=str, indent=2)
        
        logger.info("✓ SYNC COMPLETADO")
        logger.info(f"  • Total Deals: {data['summary']['total_deals']}")
        logger.info(f"  • Deals Won: {data['summary']['total_deals_won']}")
        logger.info(f"  • Deals Lost: {data['summary']['total_deals_lost']}")
        logger.info(f"  • Win Rate: {data['summary']['overall_win_rate']}%")
        logger.info(f"  • Semanas con datos: {len(data['by_week']['new_leads'])}")
        logger.info(f"  • Meses con datos: {len(data['by_month']['deals_won'])}")
        logger.info(f"  • Razones de pérdida: {len(data['closed_lost_reasons'])}")
        logger.info(f"  • Archivo: {output}")
        logger.info("="*60)
        return True
    
    except Exception as e:
        logger.error(f"✗ Error: {e}")
        import traceback
        traceback.print_exc()
        return False

if __name__ == '__main__':
    main()
